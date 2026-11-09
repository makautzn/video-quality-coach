import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";

async function startServer(overrides: NodeJS.ProcessEnv = {}) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/server/index.js"], {
    env: {
      ...process.env, PORT: String(port), FOUNDRY_PROJECT_ENDPOINT: "",
      FOUNDRY_VOICE_AGENT_NAME: "video-quality-coach", FOUNDRY_AVATAR_AGENT_NAME: "",
      AZURE_FACE_ENDPOINT: "", ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Local server did not start.")), 10_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.stdout.on("data", data => {
      if (String(data).includes("Video coach ready")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}).`)); });
  });
  return { child, origin };
}
async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await once(child, "exit");
  }
}
async function rejectsUpgrade(origin: string, path: string, requestOrigin: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + path,
      { headers: { Origin: requestOrigin } });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Upgrade rejection timed out.")); }, 3000);
    socket.on("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      socket.terminate();
      try { assert.equal(response.statusCode, 403); resolve(); } catch (error) { reject(error); }
    });
    socket.on("open", () => { clearTimeout(timeout); socket.close(); reject(new Error("Invalid socket was accepted.")); });
    socket.on("error", () => { /* An explicitly rejected upgrade emits an error on termination. */ });
  });
}
async function proxyError(origin: string, path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(origin.replace("http:", "ws:") + path, { headers: { Origin: origin } });
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Proxy error timed out.")); }, 3000);
    socket.once("message", data => {
      clearTimeout(timeout);
      try {
        const event = JSON.parse(data.toString()) as { type: string; message: string };
        assert.equal(event.type, "proxy.error");
        socket.close();
        resolve(event.message);
      } catch (error) { reject(error); }
    });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}

test("local server serves the browser modules and strictly restricts voice upgrades", async () => {
  const { child, origin } = await startServer();
  try {
    const config = await fetch(origin + "/api/config");
    assert.equal(config.status, 200);
    const settings = await config.json() as {
      configured: boolean; faceConfigured: boolean; faceOutlineSupported: boolean; faceExposureSupported: boolean;
      avatarConfigured: boolean; avatarError: string;
    };
    assert.equal(settings.configured, false);
    assert.equal(settings.faceConfigured, false);
    assert.equal(settings.faceOutlineSupported, true);
    assert.equal(settings.faceExposureSupported, true);
    assert.equal(settings.avatarConfigured, false);
    assert.match(settings.avatarError, /FOUNDRY_AVATAR_AGENT_NAME/);
    assert.equal((await fetch(origin + "/")).status, 200);
    for (const path of ["/client/main.js", "/client/audio.js", "/shared/protocol.js", "/capture-worklet.js"]) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("content-type") ?? "", /javascript/);
    }
    assert.equal((await fetch(origin + "/.env")).status, 404);
    assert.equal((await fetch(origin + "/api/config", { headers: { Origin: "https://evil.test" } })).status, 403);
    assert.equal((await fetch(origin + "/api/config", { method: "POST" })).status, 405);
    const faceRequest = {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/octet-stream",
        "X-Frame-Width": "768",
        "X-Frame-Height": "432",
      },
      body: new Uint8Array([0xff, 0xd8, 0xff]),
    };
    const faceDisabled = await fetch(origin + "/api/face-assessment", faceRequest);
    assert.equal(faceDisabled.status, 503);
    assert.match((await faceDisabled.json() as { error: string }).error, /AZURE_FACE_ENDPOINT/);
    const crossOriginFace = await fetch(origin + "/api/face-assessment", {
      ...faceRequest, headers: { ...faceRequest.headers, Origin: "https://evil.test" },
    });
    assert.equal(crossOriginFace.status, 403);
    for (const path of ["/voice", "/voice?mode=avatar"]) {
      await rejectsUpgrade(origin, path, "https://evil.test");
    }
    for (const path of ["/voice?agent=other", "/voice?mode=voice", "/voice?mode=avatar&agent=other"]) {
      await rejectsUpgrade(origin, path, origin);
    }
    assert.match(await proxyError(origin, "/voice"), /FOUNDRY_PROJECT_ENDPOINT/);
    assert.match(await proxyError(origin, "/voice?mode=avatar"), /FOUNDRY_AVATAR_AGENT_NAME/);
  } finally {
    await stopServer(child);
  }
});

test("avatar availability requires a separate configured agent without blocking voice-only mode", async () => {
  const endpoint = "https://example.services.ai.azure.com/api/projects/demo";
  for (const [avatar, expected] of [["avatar-agent", true], ["voice-agent", false]] as const) {
    const { child, origin } = await startServer({
      FOUNDRY_PROJECT_ENDPOINT: endpoint, FOUNDRY_VOICE_AGENT_NAME: "voice-agent",
      FOUNDRY_AVATAR_AGENT_NAME: avatar,
    });
    try {
      const settings = await (await fetch(origin + "/api/config")).json() as {
        configured: boolean; avatarConfigured: boolean; avatarError?: string;
      };
      assert.equal(settings.configured, true);
      assert.equal(settings.avatarConfigured, expected);
      if (!expected) {
        assert.match(settings.avatarError ?? "", /separate avatar-enabled agent/);
        assert.match(await proxyError(origin, "/voice?mode=avatar"), /separate avatar-enabled agent/);
      }
    } finally { await stopServer(child); }
  }
});
