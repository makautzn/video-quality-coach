import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { AzureCliCredential } from "@azure/identity";
import WebSocket, { WebSocketServer } from "ws";
import { faceServiceError } from "./face-errors.js";
import { assessFaces, faceDetectUrl } from "../shared/face-assessment.js";
import { isLocalRequest, voiceMode, voiceUrl } from "../shared/protocol.js";

const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid PORT.");
const origin = `http://127.0.0.1:${port}`;
const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT;
const agent = process.env.FOUNDRY_VOICE_AGENT_NAME ?? "video-quality-coach";
const upstreamUrl = endpoint ? voiceUrl(endpoint, agent) : undefined;
const avatarAgent = process.env.FOUNDRY_AVATAR_AGENT_NAME?.trim();
const avatarError = !avatarAgent ? "Set FOUNDRY_AVATAR_AGENT_NAME in .env to enable the avatar." :
  avatarAgent === agent ? "FOUNDRY_AVATAR_AGENT_NAME must name a separate avatar-enabled agent." :
    !endpoint ? "Set FOUNDRY_PROJECT_ENDPOINT in .env to enable the avatar." : undefined;
const avatarUpstreamUrl = endpoint && avatarAgent && !avatarError ? voiceUrl(endpoint, avatarAgent) : undefined;
const faceEndpoint = process.env.AZURE_FACE_ENDPOINT;
const faceUrl = faceEndpoint ? faceDetectUrl(faceEndpoint) : undefined;
const maxImageBytes = 700_000;
const credential = new AzureCliCredential({
  subscription: process.env.AZURE_SUBSCRIPTION_ID,
  processTimeoutInMs: 12_000,
});
class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function readImage(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > maxImageBytes) {
    throw new RequestError(413, "Camera snapshot is too large. Try again with a smaller frame.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxImageBytes) {
      request.resume();
      throw new RequestError(413, "Camera snapshot is too large. Try again with a smaller frame.");
    }
    chunks.push(bytes);
  }
  const image = Buffer.concat(chunks, length);
  if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) {
    throw new RequestError(400, "Camera snapshot is not a valid JPEG image.");
  }
  return image;
}
const mime: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".map": "application/json",
};
let faceAssessmentActive = false;
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self)");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "connect-src 'self' ws://127.0.0.1:" + port + "; img-src 'self' data:; " +
    "media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'none'");
  if (!isLocalRequest(req.socket.remoteAddress, req.headers.host, req.headers.origin, origin)) {
    res.writeHead(403).end("Use " + origin);
    return;
  }
  const requestUrl = new URL(req.url ?? "/", origin);
  if (req.method === "POST" && requestUrl.pathname === "/api/face-assessment") {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.origin !== origin) {
      res.writeHead(403).end(JSON.stringify({ error: "Use the local video-coach page to submit a frame." }));
      return;
    }
    if (!faceUrl) {
      res.writeHead(503).end(JSON.stringify({ error: "Set AZURE_FACE_ENDPOINT in .env to enable Face-backed checks." }));
      return;
    }
    if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") {
      res.writeHead(415).end(JSON.stringify({ error: "Submit a JPEG camera snapshot." }));
      return;
    }
    const width = Number(req.headers["x-frame-width"]);
    const height = Number(req.headers["x-frame-height"]);
    if (!Number.isInteger(width) || !Number.isInteger(height) ||
        width < 128 || height < 128 || width > 1920 || height > 1080) {
      res.writeHead(400).end(JSON.stringify({ error: "Invalid camera frame dimensions." }));
      return;
    }
    if (faceAssessmentActive) {
      res.writeHead(429).end(JSON.stringify({ error: "A frame check is already in progress. Try again shortly." }));
      return;
    }
    faceAssessmentActive = true;
    const startedAt = Date.now();
    const disconnected = new AbortController();
    const abortOnClose = () => { if (!res.writableEnded) disconnected.abort(); };
    res.once("close", abortOnClose);
    try {
      const image = await readImage(req);
      const imageBody = new Uint8Array(image);
      const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
      if (disconnected.signal.aborted) return;
      if (!token) throw new Error("Azure authentication returned no Face access token.");
      const faceResponse = await fetch(faceUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: imageBody,
        signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(15_000)]),
      });
      if (disconnected.signal.aborted) return;
      if (!faceResponse.ok) {
        const errorBody: unknown = await faceResponse.json().catch(() => undefined);
        const serviceError = errorBody && typeof errorBody === "object" && "error" in errorBody
          ? errorBody.error : undefined;
        const code = serviceError && typeof serviceError === "object" && "code" in serviceError &&
          typeof serviceError.code === "string" ? serviceError.code : undefined;
        console.warn("Azure Face request failed", {
          status: faceResponse.status, code, durationMs: Date.now() - startedAt,
        });
        throw new RequestError(502, faceServiceError(
          faceResponse.status, code, faceResponse.headers.get("apim-request-id"),
        ));
      }
      const detections: unknown = await faceResponse.json();
      const assessment = assessFaces(detections, width, height);
      res.writeHead(200).end(JSON.stringify(assessment));
    } catch (error) {
      if (disconnected.signal.aborted) return;
      const status = error instanceof RequestError ? error.status : 502;
      const message = error instanceof RequestError ? error.message :
        error instanceof Error && error.name === "TimeoutError"
          ? "Azure Face took too long to respond. Try again."
          : error instanceof Error && error.message.startsWith("Azure authentication")
            ? error.message
            : "Could not complete the Azure Face check. Verify sign-in, endpoint access, and try again.";
      if (!(error instanceof RequestError)) {
        console.warn("Azure Face assessment failed", { durationMs: Date.now() - startedAt });
      }
      if (!res.headersSent) res.writeHead(status).end(JSON.stringify({ error: message }));
    } finally {
      res.removeListener("close", abortOnClose);
      faceAssessmentActive = false;
    }
    return;
  }
  if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
  try {
    const path = requestUrl.pathname;
    if (path === "/api/config") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        configured: Boolean(upstreamUrl), faceConfigured: Boolean(faceUrl), faceOutlineSupported: true,
        faceExposureSupported: true,
        avatarConfigured: Boolean(avatarUpstreamUrl), avatarError, endpoint, agent,
      }));
      return;
    }
    const root = resolve(path.startsWith("/client/") || path.startsWith("/shared/") ? "dist" : "public");
    const relative = path === "/" ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end("Forbidden"); return; }
    const bytes = await readFile(file);
    res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    res.end(bytes);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      res.writeHead(404).end("Not found");
    } else {
      console.error("HTTP request failed:", error instanceof Error ? error.message : "unknown error");
      res.writeHead(500).end("Local server error");
    }
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
let active = false;
server.on("upgrade", (req, socket, head) => {
  if (!voiceMode(req.url) || req.headers.origin !== origin ||
      !isLocalRequest(req.socket.remoteAddress, req.headers.host, req.headers.origin, origin)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(req, socket, head, client => sockets.emit("connection", client, req));
});
sockets.on("connection", (client, req) => {
  const mode = voiceMode(req.url);
  const selectedUrl = mode === "avatar" ? avatarUpstreamUrl : upstreamUrl;
  if (active || !selectedUrl) {
    client.send(JSON.stringify({ type: "proxy.error", message: active ?
      "A coaching session is already connected." :
      mode === "avatar" ? avatarError ?? "Avatar is not configured." : "Set FOUNDRY_PROJECT_ENDPOINT in .env." }));
    client.close(1008);
    return;
  }
  active = true;
  let upstream: WebSocket | undefined;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    active = false;
    clearInterval(heartbeat);
    upstream?.close();
  };
  const fail = (message: string) => {
    if (closed) return;
    console.error("Voice proxy:", message);
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "proxy.error", message }));
      client.close(1011);
    }
    finish();
  };
  const heartbeat = setInterval(() => {
    if (client.readyState === WebSocket.OPEN) client.ping();
  }, 20_000);
  client.on("close", finish);
  client.on("error", () => fail("Browser connection failed."));
  client.on("message", (data, binary) => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      fail("Azure connection is not ready.");
      return;
    }
    if (binary) { fail("Only JSON voice events are supported."); return; }
    try {
      const event: unknown = JSON.parse(data.toString());
      if (!event || typeof event !== "object" || !("type" in event) ||
          typeof event.type !== "string" ||
          !["session.update", "session.avatar.connect", "conversation.item.create",
            "conversation.item.delete", "input_audio_buffer.append", "input_audio_buffer.clear",
            "response.create", "response.cancel", "conversation.item.truncate"].includes(event.type)) {
        fail("Unsupported client event.");
        return;
      }
      if (upstream.bufferedAmount > 2_000_000) {
        fail("Azure connection is too slow. Reconnect and try again.");
        return;
      }
      upstream.send(data.toString());
    } catch { fail("Invalid JSON voice event."); }
  });
  void (async () => {
    try {
      const token = await credential.getToken("https://ai.azure.com/.default");
      if (closed) return;
      const sessionUrl = new URL(selectedUrl);
      sessionUrl.searchParams.set("agent_session_id", randomUUID());
      upstream = new WebSocket(sessionUrl, {
        headers: {
          Authorization: `Bearer ${token.token}`,
          "Foundry-Features": "VoiceAgents=V1Preview",
        },
        handshakeTimeout: 20_000,
        maxPayload: 8_000_000,
      });
      upstream.on("open", () => {
        client.send(JSON.stringify({ type: "proxy.connected" }));
      });
      upstream.on("message", (data) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 4_000_000) { fail("Browser is too slow to receive voice output."); return; }
        client.send(data.toString());
      });
      upstream.on("unexpected-response", (_request, response) => {
        response.resume();
        fail(`Azure rejected the voice connection (HTTP ${response.statusCode}). Check the agent, role and network access.`);
      });
      upstream.on("error", () => fail("Cannot open Azure voice connection. Check Azure CLI sign-in and project access."));
      upstream.on("close", (code) => {
        if (!closed) {
          client.send(JSON.stringify({ type: "proxy.closed", code }));
          client.close();
          finish();
        }
      });
    } catch (error) {
      fail("Azure authentication failed: " + (error instanceof Error ? error.message : "unknown error"));
    }
  })();
});
server.listen(port, "127.0.0.1", () => console.log(`Video coach ready at ${origin}`));
