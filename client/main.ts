import { AudioIO } from "./audio.js";
import {
  applyCoachingSettings, defaultCoachingSettings, framingCue, FramingCueGate, isCoachingSettings, isFaceAssessment,
} from "../shared/face-assessment.js";
import type { CoachingSettings, FaceAssessment } from "../shared/face-assessment.js";
import {
  avatarIceServers, decodeAvatarAnswer, encodeAvatarOffer, parseVoiceControl, ResponseGate, sessionSettings, waitForAvatarIce,
} from "../shared/protocol.js";

function element<T extends Element>(id: string, type: { new(): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing UI element: ${id}`);
  return found;
}
const button = (id: string) => element(id, HTMLButtonElement);
const checkbox = (id: string) => element(id, HTMLInputElement);
const camera = element("camera", HTMLVideoElement);
const faceOutline = element("face-outline", SVGSVGElement);
const faceRectangle = element("face-rectangle", SVGRectElement);
const guides = element("guides", SVGSVGElement);
const headGuide = element("head-guide", SVGRectElement);
const eyeLine = element("eye-line", SVGLineElement);
const eyeLineLabel = element("eye-line-label", SVGTextElement);
const avatarVideo = element("avatar-video", HTMLVideoElement);
const avatarAudio = element("avatar-audio", HTMLAudioElement);
const status = element("status", HTMLElement);
const consent = checkbox("consent");
const avatarEnabled = checkbox("avatar-enabled");
const autoCoach = checkbox("auto-coach");
const transcript = element("transcript", HTMLElement);
const audio = new AudioIO();
let gate = new ResponseGate();
let cameraStream: MediaStream | undefined;
let microphoneStream: MediaStream | undefined;
let micEnabled = false;
let socket: WebSocket | undefined;
let peer: RTCPeerConnection | undefined;
let avatarAbort: AbortController | undefined;
let recorder: MediaRecorder | undefined;
let recordUrl: string | undefined;
let connecting = false;
let connectionAttempt = 0;
let sessionUsesAvatar = false;
let configured = false;
let cameraBusy = false;
let recordBusy = false;
let micBusy = false;
let faceConfigured = false;
let faceOutlineSupported = false;
let faceExposureSupported = false;
let faceBoxEnabled = false;
let faceBoxAvailable = false;
let faceCheck: AbortController | undefined;
let automaticFaceCheck = false;
const automaticCueGate = new FramingCueGate();
let avatarConfigured = false;
let responseTimer: ReturnType<typeof setTimeout> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let avatarTimer: ReturnType<typeof setTimeout> | undefined;
let lastOutput: HTMLElement | undefined;
let outputSource: "text" | "audio" | undefined;
let requestedAt = 0;
let firstOutput = false;
let receivedCount = 0;
let firstLatencies: number[] = [];
let sessionConfigurationSent = false;
let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
let processingCall = false;
let pendingAvatarMode: boolean | undefined;
let resumeMicrophone = false;
let coachingSettings: CoachingSettings = { ...defaultCoachingSettings };
const settingsFields: Array<[keyof CoachingSettings, string, string]> = [
  ["eyeLine", "setting-eye", "value-eye"], ["headX", "setting-x", "value-x"],
  ["headY", "setting-y", "value-y"], ["headWidth", "setting-width", "value-width"],
  ["headHeight", "setting-height", "value-height"], ["exposureMin", "setting-light-min", "value-light-min"],
  ["exposureMax", "setting-light-max", "value-light-max"],
];

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const target = element("error", HTMLElement);
  target.textContent = message;
  target.hidden = false;
  console.error(message);
}
function clearError(): void { element("error", HTMLElement).hidden = true; }
function clearFaceBox(): void {
  faceBoxAvailable = false;
  faceOutline.setAttribute("hidden", "");
  faceOutline.removeAttribute("viewBox");
  for (const name of ["x", "y", "width", "height"]) faceRectangle.removeAttribute(name);
}
function cancelFaceCheck(): void {
  faceCheck?.abort();
  faceCheck = undefined;
  automaticFaceCheck = false;
  clearFaceBox();
}
function renderFaceBox(): void {
  faceOutline.toggleAttribute("hidden", !(
    faceOutlineSupported && faceBoxEnabled && faceBoxAvailable && cameraStream && consent.checked
  ));
}
function renderGuides(): void {
  const width = camera.videoWidth || 1600;
  const height = camera.videoHeight || 900;
  guides.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const w = coachingSettings.headWidth * width;
  const h = coachingSettings.headHeight * height;
  headGuide.setAttribute("x", String(coachingSettings.headX * width - w / 2));
  headGuide.setAttribute("y", String(coachingSettings.headY * height - h / 2));
  headGuide.setAttribute("width", String(w));
  headGuide.setAttribute("height", String(h));
  headGuide.setAttribute("rx", String(w * 0.48));
  headGuide.setAttribute("ry", String(h * 0.48));
  const y = coachingSettings.eyeLine * height;
  for (const [key, value] of [["x1", 0], ["x2", width], ["y1", y], ["y2", y]] as const) {
    eyeLine.setAttribute(key, String(value));
  }
  const scale = Math.min(guides.clientWidth / width, guides.clientHeight / height) || 1;
  eyeLineLabel.setAttribute("font-size", String(10 / scale));
  eyeLineLabel.setAttribute("x", String(8 / scale));
  eyeLineLabel.setAttribute("y", String(Math.min(height - 2 / scale, y + 13 / scale)));
  for (const [key, inputId, outputId] of settingsFields) {
    const value = Math.round(coachingSettings[key] * 100);
    checkbox(inputId).value = String(value);
    element(outputId, HTMLOutputElement).textContent = `${value}%`;
  }
  checkbox("setting-light-min").max = String(Math.round(coachingSettings.exposureMax * 100) - 1);
  checkbox("setting-light-max").min = String(Math.round(coachingSettings.exposureMin * 100) + 1);
}
function saveCoachingSettings(): void {
  try { localStorage.setItem("video-coach-settings-v1", JSON.stringify(coachingSettings)); }
  catch { showError("Could not save your framing settings in this browser. They will last only for this page."); }
}
function refresh(): void {
  const connected = socket?.readyState === WebSocket.OPEN;
  const available = Boolean(connected && gate.ready && !gate.busy && !gate.speaking && !processingCall);
  button("connect").disabled = !configured || !consent.checked || connecting || Boolean(socket);
  button("connect").textContent = connecting ? "Connecting..." : "Connect coach";
  button("disconnect").disabled = !socket;
  button("assess").disabled = !available || !cameraStream || !consent.checked || cameraBusy;
  button("microphone").disabled = !connected || !gate.ready || micBusy;
  button("microphone").textContent = micEnabled ? "Mute microphone" : "Enable microphone";
  button("camera-toggle").disabled = cameraBusy || recordBusy;
  button("camera-toggle").textContent = cameraStream ? "Stop camera" : "Start camera";
  button("face-box-toggle").disabled = !faceOutlineSupported || !cameraStream || !consent.checked || cameraBusy;
  button("face-box-toggle").textContent = faceBoxEnabled ? "Hide face box" : "Show face box";
  button("face-box-toggle").setAttribute("aria-pressed", String(faceBoxEnabled));
  renderFaceBox();
  button("record").disabled = !cameraStream || recordBusy || Boolean(recorder);
  button("record").hidden = Boolean(recorder);
  button("stop-record").hidden = !recorder;
  button("stop-record").disabled = recorder?.state === "inactive";
  element("recording-label", HTMLElement).hidden = !recorder;
  button("send").disabled = !available;
  checkbox("message").disabled = !available;
  avatarEnabled.disabled = connecting || Boolean(socket) || !avatarConfigured;
  element("camera-state", HTMLElement).textContent = cameraStream ? "LIVE · LOCAL" : "OFFLINE";
  element("camera-placeholder", HTMLElement).hidden = Boolean(cameraStream);
}
function send(event: object): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Voice connection is not open.");
  if (socket.bufferedAmount > 1_000_000) throw new Error("Connection is too slow. Disconnect and try again.");
  socket.send(JSON.stringify(event));
}
function note(role: "user" | "coach", text: string): HTMLElement {
  transcript.querySelector(".empty")?.remove();
  const paragraph = document.createElement("p");
  paragraph.className = role;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "YOU" : "COACH";
  const content = document.createElement("span");
  content.textContent = text;
  paragraph.append(label, content);
  transcript.append(paragraph);
  while (transcript.children.length > 40) transcript.firstElementChild?.remove();
  transcript.scrollTop = transcript.scrollHeight;
  return content;
}
function measurementSummary(assessment: FaceAssessment): string {
  if (!assessment.faceCount) return "No face detected. No visual corrections were generated.";
  const measurements = [
    `face width ${Math.round((assessment.faceWidthRatio ?? 0) * 100)}% of frame`,
    `face center ${Math.round((assessment.faceCenterX ?? 0) * 100)}% across, ${Math.round((assessment.faceCenterY ?? 0) * 100)}% down`,
  ];
  if (assessment.yawDegrees !== null && assessment.pitchDegrees !== null && assessment.rollDegrees !== null) {
    measurements.push(`head pose yaw ${Math.round(assessment.yawDegrees)}°, pitch ${Math.round(assessment.pitchDegrees)}°, roll ${Math.round(assessment.rollDegrees)}°`);
  }
  if (assessment.blurLevel) measurements.push(`facial blur ${assessment.blurLevel}`);
  if (typeof assessment.exposureValue === "number") {
    const position = assessment.exposureValue < coachingSettings.exposureMin ? "below your minimum" :
      assessment.exposureValue >= coachingSettings.exposureMax ? "at or above your maximum" : "within your range";
    measurements.push(`facial exposure ${Math.round(assessment.exposureValue * 100)}% (${position}` +
      (assessment.exposureLevel ? `; Azure category ${assessment.exposureLevel}` : "") + ")");
  } else if (assessment.exposureLevel) {
    measurements.push(`facial exposure ${assessment.exposureLevel}; numeric score unavailable, custom thresholds were not applied`);
  } else measurements.push("facial exposure unavailable; custom thresholds were not applied");
  if (assessment.faceCount > 1) measurements.push(`${assessment.faceCount} faces detected; measurements use the largest`);
  return `Face measurements: ${measurements.join(" · ")}.`;
}
async function ensureMicrophone(): Promise<MediaStream> {
  if (!microphoneStream?.getAudioTracks().some(track => track.readyState === "live")) {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  }
  return microphoneStream;
}
function releaseUnusedMicrophone(): void {
  if (!micEnabled && !recorder) {
    microphoneStream?.getTracks().forEach(track => track.stop());
    microphoneStream = undefined;
  }
}
async function startCamera(): Promise<void> {
  cameraBusy = true;
  refresh();
  try {
    clearError();
    if (!navigator.mediaDevices) throw new Error("Camera access requires localhost or HTTPS.");
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, aspectRatio: { ideal: 16 / 9 } },
      audio: false,
    });
    const track = cameraStream.getVideoTracks()[0]!;
    track.onended = () => { void stopCamera().catch(showError); };
    camera.srcObject = cameraStream;
    await camera.play();
    status.textContent = "Camera is local. Choose Check my setup after connecting to share one frame.";
  } catch (error) {
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = undefined;
    camera.srcObject = null;
    cancelFaceCheck();
    throw error;
  } finally { cameraBusy = false; refresh(); }
}
async function stopRecording(): Promise<void> {
  const current = recorder;
  if (!current) return;
  await new Promise<void>((resolve, reject) => {
    current.addEventListener("stop", () => resolve(), { once: true });
    current.addEventListener("error", () => reject(new Error("Recording failed.")), { once: true });
    if (current.state !== "inactive") current.stop();
  });
}
async function stopCamera(): Promise<void> {
  cameraBusy = true;
  faceBoxEnabled = false;
  cancelFaceCheck();
  refresh();
  try {
    await stopRecording();
    for (const track of cameraStream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    cameraStream = undefined;
    camera.srcObject = null;
    await disconnect();
    status.textContent = "Camera stopped. No frames or microphone audio are being shared.";
  } finally { cameraBusy = false; refresh(); }
}
async function startRecording(): Promise<void> {
  if (!cameraStream) throw new Error("Start the camera before recording.");
  if (!globalThis.MediaRecorder) throw new Error("This browser does not support local video recording.");
  recordBusy = true;
  refresh();
  try {
    const mic = await ensureMicrophone();
    const stream = new MediaStream([...cameraStream.getVideoTracks(), ...mic.getAudioTracks()]);
    const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4"]
      .find(value => MediaRecorder.isTypeSupported(value));
    if (!type) throw new Error("This browser has no supported recording format.");
    const current = new MediaRecorder(stream, { mimeType: type });
    const chunks: Blob[] = [];
    let bytes = 0;
    current.ondataavailable = event => {
      if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
      if (bytes > 150_000_000 && current.state === "recording") {
        status.textContent = "Recording stopped at the 150 MB local-memory limit. Download your take.";
        current.stop();
      }
    };
    current.onerror = () => showError("The browser could not finish this recording.");
    current.onstop = () => {
      if (recordUrl) URL.revokeObjectURL(recordUrl);
      recordUrl = URL.createObjectURL(new Blob(chunks, { type: current.mimeType }));
      const playback = element("playback", HTMLVideoElement);
      playback.src = recordUrl;
      const download = element("download", HTMLAnchorElement);
      download.href = recordUrl;
      download.download = `video-take-${Date.now()}.${current.mimeType.includes("mp4") ? "mp4" : "webm"}`;
      download.hidden = false;
      element("playback-panel", HTMLElement).hidden = false;
      recorder = undefined;
      releaseUnusedMicrophone();
      refresh();
    };
    recorder = current;
    current.start(1000);
    status.textContent = "Recording camera and microphone locally. Remember to download your take.";
  } finally { recordBusy = false; releaseUnusedMicrophone(); refresh(); }
}
function clearResponseTimer(): void { clearTimeout(responseTimer); responseTimer = undefined; }
function armResponseTimer(): void {
  clearResponseTimer();
  responseTimer = setTimeout(() => {
    showError("The coach did not finish within 45 seconds. The session has been disconnected.");
    void disconnect().catch(showError);
  }, 45_000);
}
async function assess(automatic = false, toolCall = false): Promise<string | undefined> {
  const stream = cameraStream;
  const currentSocket = socket;
  if (!stream || !consent.checked || cameraBusy) {
    if (!automatic) throw new Error("Start the camera and consent to frame sharing first.");
    return;
  }
  const currentGate = gate;
  if (faceCheck || (!automatic && !toolCall && !currentGate.begin(Date.now())) ||
      (toolCall && (!currentGate.ready || currentGate.busy || currentGate.speaking || faceCheck))) {
    if (!automatic) status.textContent = "Wait for the current turn to finish before sharing another frame.";
    return;
  }
  const controller = new AbortController();
  faceCheck = controller;
  automaticFaceCheck = automatic;
  const attempt = connectionAttempt;
  const sourceWidth = camera.videoWidth;
  const sourceHeight = camera.videoHeight;
  const isCurrent = () => !controller.signal.aborted && cameraStream === stream &&
    !cameraBusy && consent.checked && socket === currentSocket &&
    currentSocket?.readyState === WebSocket.OPEN && gate === currentGate &&
    connectionAttempt === attempt && camera.videoWidth === sourceWidth && camera.videoHeight === sourceHeight &&
    (!automatic || (autoCoach.checked && !document.hidden));
  let responseSent = false;
  let ownsGate = !automatic && !toolCall;
  if (!automatic) clearFaceBox();
  try {
    const canvas = document.createElement("canvas");
    if (!sourceWidth || !sourceHeight) throw new Error("Wait for a camera frame.");
    canvas.width = Math.min(768, sourceWidth);
    canvas.height = Math.round(canvas.width * sourceHeight / sourceWidth);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cannot capture a camera frame in this browser.");
    context.drawImage(camera, 0, 0, canvas.width, canvas.height);
    const image = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.7));
    if (!isCurrent()) return;
    if (!image || image.size > 700_000) throw new Error("Could not encode a small JPEG camera frame.");
    if (!automatic) {
      clearError();
      element("measurement-result", HTMLElement).textContent = "Measuring one snapshot with Azure Face…";
      status.textContent = "Checking face framing, head pose, blur, and facial exposure...";
    }
    const response = await fetch("/api/face-assessment", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Frame-Width": String(canvas.width),
        "X-Frame-Height": String(canvas.height),
      },
      body: image,
      signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (!isCurrent()) return;
    if (!response.ok) {
      const error = object(payload);
      throw new Error(typeof error.error === "string" ? error.error : "Azure Face assessment failed.");
    }
    if (!isFaceAssessment(payload)) {
      throw new Error("The local server returned an invalid face assessment.");
    }
    if (faceOutlineSupported && payload.faceRectangle === undefined) {
      throw new Error("The local server did not return the advertised face box.");
    }
    if (faceOutlineSupported && payload.faceRectangle) {
      const box = payload.faceRectangle;
      faceOutline.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);
      faceRectangle.setAttribute("x", String(box.left * sourceWidth));
      faceRectangle.setAttribute("y", String(box.top * sourceHeight));
      faceRectangle.setAttribute("width", String(box.width * sourceWidth));
      faceRectangle.setAttribute("height", String(box.height * sourceHeight));
      faceBoxAvailable = true;
    }
    element("measurement-result", HTMLElement).textContent = measurementSummary(payload);
    const customized = applyCoachingSettings(payload, coachingSettings);
    if (toolCall) {
      status.textContent = "Face measurements are ready.";
      return customized.spokenText;
    }
    let spokenText = customized.spokenText;
    let autoCue: ReturnType<typeof framingCue> | undefined;
    if (automatic) {
      autoCue = framingCue(payload, coachingSettings);
      if (autoCue.key === "aligned" && customized.feedback.length) {
        const text = customized.feedback[0];
        if (text) autoCue = { key: `setup:${text}`, text };
      }
      const now = Date.now();
      if (!automaticCueGate.shouldSpeak(autoCue, now) || processingCall || !currentGate.begin(now, false)) return;
      ownsGate = true;
      spokenText = autoCue.text;
    }
    requestedAt = performance.now();
    firstOutput = false;
    const instruction =
      "Speak in English (US). Read this exact approved English camera-feedback line aloud " +
      "verbatim; do not translate it, change language, or add observations: " +
      `"${spokenText}"`;
    send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: instruction }] },
    });
    send({ type: "response.create" });
    responseSent = true;
    if (autoCue) automaticCueGate.spoken(autoCue, Date.now());
    armResponseTimer();
    status.textContent = "Face measurements are ready. The voice coach is sharing grounded feedback...";
  } catch (error) {
    if (!isCurrent()) return;
    clearFaceBox();
    element("measurement-result", HTMLElement).textContent = "The Face check failed; no measurements were produced.";
    status.textContent = "Face check failed. Review the error above before retrying.";
    throw error;
  } finally {
    if (faceCheck === controller) {
      faceCheck = undefined;
      automaticFaceCheck = false;
    }
    if (ownsGate && !responseSent && gate === currentGate) {
      clearResponseTimer();
      currentGate.busy = false;
      requestedAt = 0;
    }
    refresh();
  }
}
function firstResponseOutput(): void {
  if (firstOutput || !requestedAt) return;
  firstOutput = true;
  const latency = Math.round(performance.now() - requestedAt);
  firstLatencies.push(latency);
  if (firstLatencies.length > 100) firstLatencies.shift();
  const sorted = [...firstLatencies].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  element("metrics", HTMLElement).textContent =
    `${++receivedCount} requested turns · first output ${latency} ms · median ${median} ms. ` +
    `Mode: ${sessionUsesAvatar ? "avatar" : "voice only"}. These timings do not prove audible or avatar startup latency.`;
}
async function connect(): Promise<void> {
  if (!consent.checked || socket || connecting) return;
  const attempt = ++connectionAttempt;
  connecting = true;
  sessionUsesAvatar = avatarEnabled.checked;
  sessionConfigurationSent = false;
  gate = new ResponseGate();
  clearError();
  refresh();
  try {
    await ensureMicrophone();
    if (attempt !== connectionAttempt || !consent.checked) { releaseUnusedMicrophone(); return; }
    await audio.unlock();
    if (attempt !== connectionAttempt || !consent.checked) { releaseUnusedMicrophone(); return; }
    resumeMicrophone = true;
    peer?.close();
    peer = undefined;
    avatarVideo.hidden = true;
    const current = new WebSocket(`ws://${location.host}/voice${sessionUsesAvatar ? "?mode=avatar" : ""}`);
    socket = current;
    connectionTimer = setTimeout(() => {
      showError("Voice connection timed out.");
      void disconnect().catch(showError);
    }, 30_000);
    current.onmessage = event => {
      if (socket !== current) return;
      void Promise.resolve().then(() => handleEvent(JSON.parse(String(event.data)) as unknown)).catch(error => {
        if (socket !== current) return;
        showError(error);
        void disconnect().catch(showError);
      });
    };
    current.onerror = () => {
      if (socket !== current) return;
      showError("Voice connection failed. Check that the local server is running.");
    };
    current.onclose = () => {
      if (socket !== current) return;
      showError("The voice connection closed. Reconnect to continue coaching.");
      void disconnect().catch(showError);
    };
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    await disconnect();
    throw error;
  }
}
async function disconnect(): Promise<void> {
  cancelFaceCheck();
  automaticCueGate.reset();
  connectionAttempt++;
  const current = socket;
  socket = undefined;
  clearTimeout(connectionTimer);
  clearTimeout(avatarTimer);
  clearResponseTimer();
  if (current) { current.onclose = null; current.onmessage = null; current.close(); }
  connecting = false;
  gate = new ResponseGate();
  pendingCalls = [];
  processingCall = false;
  pendingAvatarMode = undefined;
  resumeMicrophone = false;
  requestedAt = 0;
  avatarAbort?.abort();
  avatarAbort = undefined;
  peer?.close();
  peer = undefined;
  avatarVideo.srcObject = null;
  avatarAudio.srcObject = null;
  avatarVideo.hidden = true;
  sessionUsesAvatar = false;
  micEnabled = false;
  audio.stopCapture();
  releaseUnusedMicrophone();
  await audio.close();
  status.textContent = "Coach disconnected. Local camera and recording are independent.";
  element("connection-state", HTMLElement).textContent = "NOT CONNECTED";
  refresh();
}
async function toggleMicrophone(): Promise<void> {
  micBusy = true;
  refresh();
  try {
    if (micEnabled) {
      micEnabled = false;
      audio.stopCapture();
      send({ type: "input_audio_buffer.clear" });
      releaseUnusedMicrophone();
    } else {
      const stream = await ensureMicrophone();
      if (!socket || !consent.checked) { releaseUnusedMicrophone(); return; }
      await audio.capture(stream, data => {
        try {
          if (micEnabled && consent.checked && !processingCall) {
            send({ type: "input_audio_buffer.append", audio: data });
          }
        } catch (error) { showError(error); void disconnect().catch(showError); }
      });
      if (!socket || !consent.checked) {
        audio.stopCapture();
        releaseUnusedMicrophone();
        return;
      }
      micEnabled = true;
    }
    status.textContent = micEnabled ? "Microphone is shared with Azure. Say “check my setup” or ask to change a control; headphones help prevent echo." :
      "Microphone muted for Azure. Local recording, if active, still captures your voice.";
  } finally { micBusy = false; releaseUnusedMicrophone(); refresh(); }
}
function resumeMicrophoneIfRequested(): void {
  if (!resumeMicrophone) return;
  resumeMicrophone = false;
  void toggleMicrophone().catch(showError);
}
async function switchAvatarMode(enabled: boolean): Promise<void> {
  await disconnect();
  avatarEnabled.checked = enabled;
  refresh();
  try { await connect(); }
  catch (error) {
    resumeMicrophone = false;
    throw error;
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voice protocol object.");
  return value as Record<string, unknown>;
}
async function runControl(name: string, rawArguments: string): Promise<string> {
  const control = parseVoiceControl(name, rawArguments);
  const action = control.action;
  switch (action) {
    case "check_setup": {
      const feedback = await assess(false, true);
      if (!feedback) throw new Error("The setup check could not run. Make sure the camera and consent are enabled and try again.");
      return `Read this exact approved feedback without additions: ${feedback}`;
    }
    case "start_camera":
      if (!cameraStream) await startCamera();
      return "Camera is on.";
    case "stop_camera":
      if (!cameraStream) return "Camera is already off.";
      await stopCamera();
      return "Camera stopped and coach disconnected.";
    case "show_face_box":
    case "hide_face_box":
      if (!faceOutlineSupported || !cameraStream || !consent.checked || cameraBusy) throw new Error("The face box is unavailable until the camera and consent are enabled.");
      faceBoxEnabled = action === "show_face_box";
      refresh();
      return faceBoxEnabled ? "Face box enabled for the latest checked snapshot." : "Face box hidden.";
    case "start_recording":
      if (recorder || recordBusy) throw new Error("A recording is already in progress.");
      await startRecording();
      return "Recording started locally.";
    case "stop_recording":
      if (!recorder) throw new Error("No recording is in progress.");
      await stopRecording();
      return "Recording stopped locally; the take can be downloaded.";
    case "download_take": {
      const download = element("download", HTMLAnchorElement);
      if (download.hidden || !recordUrl) throw new Error("There is no finished take to download.");
      download.click();
      return "The browser was asked to download the take; check its downloads.";
    }
    case "enable_auto":
    case "disable_auto":
      autoCoach.checked = action === "enable_auto";
      autoCoach.dispatchEvent(new Event("change"));
      refresh();
      return autoCoach.checked ? "Automatic framing checks enabled about every 3.5 seconds." : "Automatic checks disabled.";
    case "mute_microphone":
      if (micEnabled) await toggleMicrophone();
      return "Microphone muted; use the button to enable it again.";
    case "enable_microphone":
      if (!micEnabled) await toggleMicrophone();
      return "Microphone enabled.";
    case "disconnect":
      await disconnect();
      return "Coach disconnected.";
    case "enable_avatar":
    case "disable_avatar":
      if (!avatarConfigured) throw new Error("The avatar is not configured.");
      if (sessionUsesAvatar === (action === "enable_avatar")) return "That avatar mode is already active.";
      pendingAvatarMode = action === "enable_avatar";
      return "The coach will reconnect in the requested avatar mode.";
    case "revoke_consent":
      consent.checked = false;
      consent.dispatchEvent(new Event("change"));
      return "Consent revoked and coach disconnected.";
    case "grant_consent":
      if (!consent.checked) throw new Error("Enable consent manually before connecting the coach.");
      return "Consent is already enabled.";
    case "reset_settings":
      button("reset-settings").click();
      return "Framing and exposure settings were reset.";
    case "set_target": {
      const inputs = {
        eye_line: "setting-eye", head_x: "setting-x", head_y: "setting-y",
        head_width: "setting-width", head_height: "setting-height",
        exposure_min: "setting-light-min", exposure_max: "setting-light-max",
      } as const;
      if (!control.target || control.value === undefined) throw new Error("A target and percentage are required.");
      const input = checkbox(inputs[control.target]);
      if (input.disabled) throw new Error("That setting is unavailable on this server.");
      if (control.value < Number(input.min) || control.value > Number(input.max)) {
        throw new Error(`That setting must be between ${input.min}% and ${input.max}%.`);
      }
      const previousX = coachingSettings.headX;
      const previousY = coachingSettings.headY;
      input.value = String(control.value);
      input.dispatchEvent(new Event("input"));
      const shifted = (control.target === "head_width" || control.target === "head_height") &&
        (previousX !== coachingSettings.headX || previousY !== coachingSettings.headY);
      return `The ${control.target.replaceAll("_", " ")} setting is now ${input.value} percent.` +
        (shifted ? " The head position was adjusted to keep the guide inside the frame." : "");
    }
    default:
      throw new Error("This voice control is not supported.");
  }
}
async function startAvatar(session: Record<string, unknown>): Promise<void> {
  if (peer) return;
  const current = new RTCPeerConnection({ iceServers: avatarIceServers(session.avatar) });
  const controller = new AbortController();
  peer = current;
  avatarAbort = controller;
  let videoReady = false;
  let audioReady = false;
  const ready = () => {
    if (peer !== current || current.connectionState !== "connected" || !videoReady || !audioReady) return;
    clearTimeout(avatarTimer);
    avatarTimer = undefined;
    connecting = false;
    gate.ready = true;
    element("connection-state", HTMLElement).textContent = "CONNECTED";
    status.textContent = "Avatar connected. Check your setup or enable the microphone.";
    resumeMicrophoneIfRequested();
    refresh();
  };
  const playbackFailed = (kind: string) => {
    if (peer !== current) return;
    showError(`Avatar ${kind} playback failed or was blocked. Allow media playback, or reconnect in voice-only mode.`);
    void disconnect().catch(showError);
  };
  current.addTransceiver("video", { direction: "recvonly" });
  current.addTransceiver("audio", { direction: "recvonly" });
  current.ontrack = event => {
    if (peer !== current) return;
    const stream = new MediaStream([event.track]);
    if (event.track.kind === "video") {
      avatarVideo.srcObject = stream;
      avatarVideo.hidden = false;
      void avatarVideo.play().then(() => { videoReady = true; ready(); }).catch(() => playbackFailed("video"));
    } else if (event.track.kind === "audio") {
      avatarAudio.srcObject = stream;
      void avatarAudio.play().then(() => { audioReady = true; ready(); }).catch(() => playbackFailed("audio"));
    }
  };
  current.onconnectionstatechange = () => {
    if (peer !== current) return;
    if (current.connectionState === "connected") {
      ready();
    } else if (current.connectionState === "failed") {
      showError("Avatar WebRTC failed. Disconnect and reconnect in voice-only mode.");
      void disconnect().catch(showError);
    }
  };
  await current.setLocalDescription(await current.createOffer());
  let offer: RTCSessionDescriptionInit;
  try { offer = await waitForAvatarIce(current, 15_000, controller.signal); }
  finally { if (avatarAbort === controller) avatarAbort = undefined; }
  if (peer !== current || !socket) return;
  send({ type: "session.avatar.connect", client_sdp: encodeAvatarOffer(offer) });
  avatarTimer = setTimeout(() => {
    showError("Avatar did not connect. Disconnect and try voice-only mode.");
    void disconnect().catch(showError);
  }, 25_000);
}
async function handleEvent(value: unknown): Promise<void> {
  const event = object(value);
  switch (event.type) {
    case "proxy.connected":
      status.textContent = "Azure connection opened. Waiting for the voice session...";
      break;
    case "session.updated":
      if (!sessionConfigurationSent) {
        sessionConfigurationSent = true;
        const output = sessionUsesAvatar ? {} : object(object(object(event.session).audio).output);
        send(sessionSettings(output, sessionUsesAvatar));
        break;
      }
      clearTimeout(connectionTimer);
      if (sessionUsesAvatar) {
        gate.ready = false;
        element("connection-state", HTMLElement).textContent = "CONNECTING AVATAR";
        status.textContent = "Preparing the avatar connection...";
        await startAvatar(object(event.session));
      } else {
        connecting = false;
        gate.ready = true;
        element("connection-state", HTMLElement).textContent = "CONNECTED";
        status.textContent = "Coach ready. Check your setup to share a current frame.";
        resumeMicrophoneIfRequested();
      }
      break;
    case "session.avatar.connecting":
      if (!peer || typeof event.server_sdp !== "string") throw new Error("Azure returned no avatar SDP answer.");
      await peer.setRemoteDescription(decodeAvatarAnswer(event.server_sdp));
      break;
    case "response.created":
      gate.busy = true;
      outputSource = undefined;
      lastOutput = note("coach", "");
      armResponseTimer();
      break;
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      if (typeof event.delta === "string") {
        const source = event.type === "response.output_text.delta" ? "text" : "audio";
        if (!outputSource || outputSource === source) {
          outputSource = source;
          lastOutput ??= note("coach", "");
          lastOutput.textContent += event.delta;
          firstResponseOutput();
        }
      }
      break;
    case "response.output_audio.delta":
      if (typeof event.delta === "string" && !sessionUsesAvatar) {
        audio.play(event.delta);
        firstResponseOutput();
      }
      break;
    case "input_audio_buffer.speech_started":
      gate.speaking = true;
      audio.stopPlayback();
      break;
    case "input_audio_buffer.speech_stopped":
      gate.speaking = false;
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (typeof event.transcript === "string") note("user", event.transcript);
      break;
    case "response.function_call_arguments.done":
      if (typeof event.call_id !== "string" || typeof event.name !== "string" ||
          typeof event.arguments !== "string" || event.arguments.length > 2000) {
        throw new Error("Invalid voice control request.");
      }
      if (!pendingCalls.some(call => call.id === event.call_id)) {
        pendingCalls.push({ id: event.call_id, name: event.name, arguments: event.arguments });
      }
      break;
    case "response.done": {
      clearResponseTimer();
      gate.busy = false;
      const response = object(event.response);
      if (response.status !== "completed" && response.status !== "cancelled") {
        throw new Error(`Voice turn failed (${String(response.status)}). Reconnect and try again.`);
      }
      if (response.status === "cancelled") {
        pendingCalls = [];
        pendingAvatarMode = undefined;
        break;
      }
      if (pendingCalls.length) {
        const calls = pendingCalls;
        pendingCalls = [];
        const currentSocket = socket;
        processingCall = true;
        refresh();
        try {
          for (const [index, call] of calls.entries()) {
            let result: string;
            try {
              if (index > 0) throw new Error("Only one control can be changed per voice turn. Ask for the next action separately.");
              result = await runControl(call.name, call.arguments);
            } catch (error) {
              result = `Action failed: ${error instanceof Error ? error.message : String(error)}`;
              showError(result);
            }
            if (!currentSocket || socket !== currentSocket || currentSocket.readyState !== WebSocket.OPEN) return;
            send({ type: "conversation.item.create", item: {
              type: "function_call_output", call_id: call.id, output: result,
            } });
          }
          send({ type: "response.create" });
          gate.busy = true;
          armResponseTimer();
        } finally {
          processingCall = false;
          refresh();
        }
        break;
      }
      if (pendingAvatarMode !== undefined) {
        const enabled = pendingAvatarMode;
        pendingAvatarMode = undefined;
        void switchAvatarMode(enabled).catch(showError);
        break;
      }
      status.textContent = autoCoach.checked ? "Automatic framing checks are active." :
        "Make an adjustment, then check again. Automatic feedback is opt-in.";
      requestedAt = 0;
      break;
    }
    case "proxy.error":
      throw new Error(typeof event.message === "string" ? event.message : "Local voice proxy failed.");
    case "error": {
      const error = object(event.error);
      throw new Error(`Azure voice error: ${String(error.message ?? error.code)}`);
    }
    case "proxy.closed":
      throw new Error(`Azure closed the session (code ${String(event.code)}).`);
  }
  refresh();
}

button("camera-toggle").onclick = () => { void (cameraStream ? stopCamera() : startCamera()).catch(showError); };
button("face-box-toggle").onclick = () => { faceBoxEnabled = !faceBoxEnabled; refresh(); };
button("record").onclick = () => { void startRecording().catch(showError); };
button("stop-record").onclick = () => { void stopRecording().catch(showError); };
button("connect").onclick = () => { void connect().catch(showError); };
button("disconnect").onclick = () => { void disconnect().catch(showError); };
button("assess").onclick = () => { void assess().catch(showError); };
button("microphone").onclick = () => { void toggleMicrophone().catch(showError); };
for (const [key, inputId] of settingsFields) {
  checkbox(inputId).addEventListener("input", () => {
    const updated = { ...coachingSettings, [key]: Number(checkbox(inputId).value) / 100 };
    updated.headX = Math.max(updated.headWidth / 2, Math.min(1 - updated.headWidth / 2, updated.headX));
    updated.headY = Math.max(updated.headHeight / 2, Math.min(1 - updated.headHeight / 2, updated.headY));
    if (!isCoachingSettings(updated)) { showError("Invalid framing settings. Adjust the controls and try again."); return; }
    coachingSettings = updated;
    renderGuides();
    saveCoachingSettings();
  });
}
button("reset-settings").onclick = () => {
  coachingSettings = { ...defaultCoachingSettings };
  renderGuides();
  saveCoachingSettings();
};
consent.onchange = () => {
  if (!consent.checked) {
    autoCoach.checked = false;
    faceBoxEnabled = false;
    cancelFaceCheck();
    void disconnect().catch(showError);
  }
  refresh();
};
autoCoach.onchange = () => {
  automaticCueGate.reset();
  if (!autoCoach.checked && automaticFaceCheck) cancelFaceCheck();
  status.textContent = autoCoach.checked ? "Automatic framing checks are enabled while connected and sharing." :
    "Automatic framing checks are off.";
};
camera.addEventListener("resize", () => {
  renderGuides();
  if (faceCheck || faceBoxAvailable) {
    cancelFaceCheck();
    element("measurement-result", HTMLElement).textContent = "Camera frame size changed. Check your setup again.";
    refresh();
  }
});
avatarEnabled.onchange = () => { receivedCount = 0; firstLatencies = []; };
element("message-form", HTMLFormElement).onsubmit = event => {
  event.preventDefault();
  const input = checkbox("message");
  const text = input.value.trim();
  if (!text || !gate.begin(Date.now(), false)) return;
  try {
    requestedAt = performance.now();
    firstOutput = false;
    send({ type: "conversation.item.create", item: { type: "message", role: "user",
      content: [{ type: "input_text", text }] } });
    send({ type: "response.create" });
    armResponseTimer();
    note("user", text);
    input.value = "";
  } catch (error) { gate.busy = false; showError(error); }
  refresh();
};
setInterval(() => {
  if (autoCoach.checked && consent.checked && cameraStream && !cameraBusy && gate.ready && !document.hidden &&
      socket?.readyState === WebSocket.OPEN) {
    void assess(true).catch(error => { autoCoach.checked = false; showError(error); });
  }
}, 3_500);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && socket) {
    void disconnect().catch(showError);
  }
});
window.addEventListener("beforeunload", () => {
  socket?.close();
  avatarAbort?.abort();
  peer?.close();
  cameraStream?.getTracks().forEach(track => track.stop());
  microphoneStream?.getTracks().forEach(track => track.stop());
  if (recordUrl) URL.revokeObjectURL(recordUrl);
});
void fetch("/api/config").then(async response => {
  if (!response.ok) throw new Error("Cannot load local server configuration.");
  const config = object(await response.json() as unknown);
  faceConfigured = config.faceConfigured === true;
  faceOutlineSupported = config.faceOutlineSupported === true;
  faceExposureSupported = config.faceExposureSupported === true;
  checkbox("setting-light-min").disabled = !faceExposureSupported;
  checkbox("setting-light-max").disabled = !faceExposureSupported;
  if (!faceExposureSupported) {
    element("guide-hint", HTMLElement).textContent =
      "Eye line and head height are visual only. Custom exposure thresholds need an updated server; download any take before restarting.";
  }
  avatarConfigured = config.avatarConfigured === true;
  configured = config.configured === true && faceConfigured;
  element("project-info", HTMLElement).textContent = `${String(config.agent)} · ${String(config.endpoint ?? "Not configured")}`;
  element("avatar-hint", HTMLElement).textContent = avatarConfigured ? "Preview · extra Azure charges" :
    typeof config.avatarError === "string" ? config.avatarError : "Avatar is not configured.";
  element("face-box-hint", HTMLElement).textContent = faceOutlineSupported ?
    "Latest checked snapshot only, not live tracking. The box is not recorded." :
    "Face box needs an updated local server. Download any take, then restart the server.";
  if (config.configured !== true) {
    status.textContent = "Local camera and recording work. Set the Foundry project endpoint in .env to enable voice coaching.";
  } else if (!faceConfigured) {
    status.textContent = "Local camera and recording work. Set AZURE_FACE_ENDPOINT in .env to enable grounded visual checks.";
  }
  refresh();
}).catch(error => {
  element("face-box-hint", HTMLElement).textContent = "Face box unavailable: could not load local server configuration.";
  showError(error);
});
try {
  const saved = localStorage.getItem("video-coach-settings-v1");
  if (saved) {
    const parsed: unknown = JSON.parse(saved);
    if (!isCoachingSettings(parsed)) throw new Error("Saved framing settings are invalid.");
    coachingSettings = parsed;
  }
} catch {
  showError("Could not load saved framing settings; defaults are in use.");
}
renderGuides();
new ResizeObserver(renderGuides).observe(guides);
refresh();
