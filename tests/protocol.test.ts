import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCoachingSettings, assessFaces, defaultCoachingSettings, faceDetectUrl, framingCue, FramingCueGate,
  isCoachingSettings, isFaceAssessment,
} from "../shared/face-assessment.js";
import {
  avatarIceServers, decodeAvatarAnswer, encodeAvatarOffer, isLocalRequest, parseVoiceControl, ResponseGate, sessionSettings,
  voiceMode, voiceUrl, waitForAvatarIce,
} from "../shared/protocol.js";

test("voice URL preserves project and safely encodes agent name", () => {
  assert.equal(voiceUrl("https://example.services.ai.azure.com/api/projects/demo/", "coach/name"),
    "wss://example.services.ai.azure.com/api/projects/demo/agents/coach%2Fname/endpoint/protocols/voice?api-version=v1");
});
test("untrusted project hosts and extra URL components are rejected", () => {
  for (const endpoint of [
    "http://example.services.ai.azure.com/api/projects/demo", "https://evil.test/api/projects/demo",
    "https://example.services.ai.azure.com/api/projects/demo?token=x",
    "https://user@example.services.ai.azure.com/api/projects/demo",
  ]) assert.throws(() => voiceUrl(endpoint, "coach"));
});
test("voice route allows only fixed voice-only and avatar modes", () => {
  assert.equal(voiceMode("/voice"), "voice");
  assert.equal(voiceMode("/voice?mode=avatar"), "avatar");
  for (const path of [
    undefined, "/voice/", "/voice?mode=voice", "/voice?agent=other",
    "/voice?mode=avatar&agent=other", "/voice?mode=avatar&mode=voice", "/voice?mode=%61vatar",
  ]) assert.equal(voiceMode(path), undefined);
});
test("proxy accepts only loopback address, exact host and matching origin", () => {
  const origin = "http://127.0.0.1:5173";
  assert.ok(isLocalRequest("127.0.0.1", "127.0.0.1:5173", origin, origin));
  assert.ok(isLocalRequest("::ffff:127.0.0.1", "127.0.0.1:5173", undefined, origin));
  assert.ok(!isLocalRequest("10.0.0.1", "127.0.0.1:5173", origin, origin));
  assert.ok(!isLocalRequest("127.0.0.1", "evil.test", origin, origin));
  assert.ok(!isLocalRequest("127.0.0.1", "127.0.0.1:5173", "https://evil.test", origin));
});
test("Face Detect URL requests only non-identifying detection_03 attributes", () => {
  const url = new URL(faceDetectUrl("https://video-face.cognitiveservices.azure.com/"));
  assert.equal(url.pathname, "/face/v1.0/detect");
  assert.equal(url.searchParams.get("detectionModel"), "detection_03");
  assert.equal(url.searchParams.get("returnFaceId"), "false");
  assert.equal(url.searchParams.get("returnFaceLandmarks"), "false");
  assert.equal(url.searchParams.get("returnFaceAttributes"), "blur,exposure,headPose");
  for (const endpoint of [
    "http://video-face.cognitiveservices.azure.com/",
    "https://evil.example/face",
    "https://video-face.cognitiveservices.azure.com/?key=secret",
  ]) assert.throws(() => faceDetectUrl(endpoint));
});
test("no detected face produces no appearance or lighting guesses", () => {
  const result = assessFaces([], 768, 432);
  assert.equal(result.faceCount, 0);
  assert.equal(result.faceRectangle, null);
  assert.equal(result.exposureLevel, null);
  assert.match(result.spokenText, /couldn't detect a face/i);
  assert.equal(isFaceAssessment(result), true);
});
test("face measurements produce bounded, evidence-based priorities", () => {
  const result = assessFaces([{
    faceRectangle: { left: 200, top: 50, width: 220, height: 280 },
    faceAttributes: {
      blur: { blurLevel: "high", value: 0.9 },
      exposure: { exposureLevel: "underExposure", value: 0.2 },
      headPose: { yaw: 28, pitch: 4, roll: 1 },
    },
    faceId: "must-not-be-returned",
  }], 768, 432);
  assert.equal(result.faceCount, 1);
  assert.deepEqual(result.faceRectangle, {
    left: 200 / 768, top: 50 / 432, width: 220 / 768, height: 280 / 432,
  });
  assert.equal(isFaceAssessment(result), true);
  assert.equal(result.faceWidthRatio, 220 / 768);
  assert.equal(result.yawDegrees, 28);
  assert.deepEqual(result.feedback, [
    "Your face looks underexposed; add a soft light in front of you.",
    "Your face looks blurry; hold still and check the camera focus.",
  ]);
  assert.doesNotMatch(result.spokenText, /headroom|head cut off|distance/i);
});
test("pose, framing, and facial exposure guidance use only present measurements", () => {
  const result = assessFaces([{
    faceRectangle: { left: 0, top: 0, width: 80, height: 120 },
    faceAttributes: { headPose: { yaw: 0, pitch: 30, roll: 16 } },
  }], 768, 432);
  assert.deepEqual(result.feedback, [
    "Keep your head a little more level.",
    "Level your head slightly.",
  ]);
  assert.equal(result.exposureLevel, null);
  assert.equal(result.blurLevel, null);
});
test("invalid Face coordinates and assessment payloads are rejected", () => {
  assert.throws(() => assessFaces([{ faceRectangle: { left: 760, top: 0, width: 20, height: 40 } }], 768, 432));
  assert.equal(isFaceAssessment({ faceCount: -1 }), false);
});
test("custom face exposure thresholds use the numeric score and validate bounds", () => {
  const result = assessFaces([{
    faceRectangle: { left: 260, top: 100, width: 220, height: 200 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } },
  }], 768, 432);
  assert.equal(result.exposureValue, 0.5);
  const settings = { ...defaultCoachingSettings, exposureMin: 0.6, exposureMax: 0.8 };
  assert.match(applyCoachingSettings(result, settings).spokenText, /underexposed/);
  assert.match(applyCoachingSettings(result, { ...settings, exposureMin: 0.2, exposureMax: 0.5 }).spokenText, /overexposed/);
  assert.doesNotMatch(applyCoachingSettings(result, { ...settings, exposureMin: 0.5, exposureMax: 0.8 }).spokenText, /underexposed|overexposed/);
  assert.equal(isCoachingSettings({ ...settings, exposureMin: 0.8 }), false);
  assert.equal(isFaceAssessment({ ...result, exposureValue: 1.1 }), false);
  assert.throws(() => assessFaces([{ faceRectangle: { left: 0, top: 0, width: 1, height: 1 },
    faceAttributes: { exposure: { value: -1 } } }], 768, 432), /invalid exposure/);
});
test("custom head guide applies to mirrored face coordinates and target width", () => {
  const result = assessFaces([{ faceRectangle: { left: 100, top: 110, width: 200, height: 180 } }], 768, 432);
  const settings = { ...defaultCoachingSettings, headX: 0.7, headWidth: 0.4 };
  assert.doesNotMatch(applyCoachingSettings(result, settings).spokenText, /nearer the guide/);
  assert.match(applyCoachingSettings(result, { ...settings, headX: 0.3 }).spokenText, /nearer the guide/);
  assert.match(applyCoachingSettings(result, { ...settings, headWidth: 0.6 }).spokenText, /small in frame/);
  assert.equal(isCoachingSettings({ ...settings, headX: 0.85, headWidth: 0.6 }), false);
});
test("continuous framing cues follow the mirrored preview and configured target", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const face = (x: number, y: number, width: number) => ({
    ...assessFaces([{ faceRectangle: { left: 350, top: 170, width: 300, height: 300 } }], 1000, 1000),
    faceRectangle: undefined, faceCenterX: x, faceCenterY: y, faceWidthRatio: width,
  });
  assert.equal(framingCue(face(0.7, 0.5, 0.3), settings).key, "right");
  assert.equal(framingCue(face(0.3, 0.5, 0.3), settings).key, "left");
  assert.equal(framingCue(face(0.5, 0.3, 0.3), settings).key, "down");
  assert.equal(framingCue(face(0.5, 0.7, 0.3), settings).key, "up");
  assert.equal(framingCue(face(0.5, 0.5, 0.2), settings).key, "closer");
  assert.equal(framingCue(face(0.5, 0.5, 0.4), settings).key, "back");
  assert.equal(framingCue(face(0.5, 0.5, 0.3), settings).key, "aligned");
  assert.equal(framingCue(assessFaces([], 1000, 1000), settings).key, "no-face");
  assert.equal(framingCue(face(0.5, 0.5, 0.3), { ...settings, headX: 0.7 }).key, "right");
  assert.throws(() => framingCue(face(0.5, 0.5, 0.3), { ...settings, headWidth: 0 }));
});
test("continuous coach limits repetition, confirms alignment once, and can reset", () => {
  const gate = new FramingCueGate();
  const right = { key: "right", text: "right" };
  const aligned = { key: "aligned", text: "aligned" };
  assert.equal(gate.shouldSpeak(right, 1000), true);
  gate.spoken(right, 1000);
  assert.equal(gate.shouldSpeak(aligned, 8999), false);
  assert.equal(gate.shouldSpeak(aligned, 9000), true);
  assert.equal(gate.shouldSpeak(right, 15999), false);
  assert.equal(gate.shouldSpeak(right, 16000), true);
  gate.spoken(aligned, 17000);
  assert.equal(gate.shouldSpeak(aligned, 100000), false);
  assert.equal(gate.shouldSpeak(right, 25000), true);
  gate.reset();
  assert.equal(gate.shouldSpeak(aligned, 1), true);
});
test("face boxes are bounded, agree with measurements, and support legacy responses", () => {
  const result = assessFaces([{ faceRectangle: { left: 100, top: 50, width: 200, height: 250 } }], 768, 432);
  const rectangle = result.faceRectangle;
  assert.ok(rectangle);
  for (const bad of [
    { ...rectangle, left: -0.01 },
    { ...rectangle, top: -0.01 },
    { ...rectangle, width: 0 },
    { ...rectangle, height: Number.NaN },
    { ...rectangle, left: 0.9 },
    { ...rectangle, top: 0.9 },
    { ...rectangle, width: rectangle.width + 0.01 },
    { ...rectangle, top: rectangle.top + 0.01 },
  ]) assert.equal(isFaceAssessment({ ...result, faceRectangle: bad }), false);
  assert.equal(isFaceAssessment({ ...result, faceRectangle: null }), false);
  assert.equal(isFaceAssessment({ ...assessFaces([], 768, 432), faceRectangle: rectangle }), false);
  const { faceRectangle: _removed, ...legacy } = result;
  assert.equal(isFaceAssessment(legacy), true);
  const { faceRectangle: _noFaceRemoved, ...legacyNoFace } = assessFaces([], 768, 432);
  assert.equal(isFaceAssessment(legacyNoFace), true);
});
test("response gate prevents overlap, unready requests, speech interruptions and spam", () => {
  const gate = new ResponseGate();
  assert.equal(gate.begin(10_000), false);
  gate.ready = true;
  assert.equal(gate.begin(10_000), true);
  assert.equal(gate.begin(15_000), false);
  gate.busy = false;
  assert.equal(gate.begin(12_000), false);
  assert.equal(gate.begin(12_000, false), true);
  gate.busy = false;
  gate.speaking = true;
  assert.equal(gate.begin(15_000), false);
  gate.speaking = false;
  assert.equal(gate.begin(17_000), true);
});
test("session updates preserve the server's Azure voice instead of resetting its provider", () => {
  const output = { voice: "configured-voice", voice_type: "azure-standard",
    format: { type: "audio/pcm", rate: 24_000 } };
  const event = sessionSettings(output, false);
  assert.deepEqual(event.session.audio.output, output);
  assert.match(event.session.instructions, /Never inspect or infer from images/);
  assert.match(event.session.instructions, /Speak English \(US\) only/);
  assert.match(event.session.instructions, /Never change language/);
  assert.match(event.session.instructions, /Never translate or paraphrase approved English feedback/);
  assert.deepEqual(event.session.output_modalities, ["audio", "text"]);
  assert.equal(event.session.audio.input.turn_detection.auto_truncate, true);
  assert.equal("avatar" in event.session, false);
  assert.equal(event.session.tool_choice, "auto");
  assert.equal(event.session.tools[0]?.name, "control_app");
  const actions = event.session.tools[0]!.parameters.properties.action.enum;
  for (const action of ["check_setup", "show_face_box", "hide_face_box", "start_recording",
    "stop_recording", "download_take", "enable_auto", "disable_auto", "mute_microphone", "disconnect"]) {
    assert.ok(actions.some(candidate => candidate === action), `Missing voice action: ${action}`);
  }
  const avatar = sessionSettings(output, true).session;
  assert.deepEqual(avatar.output_modalities, ["audio", "text", "avatar"]);
  assert.equal(avatar.audio.input.turn_detection.auto_truncate, true);
  assert.equal("output" in avatar.audio, false);
  assert.equal("avatar" in avatar, false);
});
test("voice actions reject unknown tools, invalid JSON, and extra or unsupported arguments", () => {
  assert.deepEqual(parseVoiceControl("control_app", '{"action":"check_setup"}'), { action: "check_setup" });
  assert.deepEqual(parseVoiceControl("control_app", '{"action":"set_target","target":"eye_line","value":35}'),
    { action: "set_target", target: "eye_line", value: 35 });
  for (const [name, args] of [
    ["other_tool", '{"action":"check_setup"}'], ["control_app", "not-json"],
    ["control_app", "null"], ["control_app", "[]"], ["control_app", "{}"],
    ["control_app", '{"action":"check_setup","extra":true}'],
    ["control_app", '{"action":"unexpected"}'], ["control_app", '{"action":5}'],
    ["control_app", '{"action":"set_target","target":"eye_line","value":101}'],
    ["control_app", '{"action":"set_target","target":"unknown","value":20}'],
    ["control_app", " ".repeat(2001)],
  ]) assert.throws(() => parseVoiceControl(name!, args!), /Invalid voice control/);
});
test("avatar SDP is encoded and decoded as typed base64 JSON", () => {
  const offer = { type: "offer" as const, sdp: "v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 1234 typ host\r\n" };
  assert.deepEqual(JSON.parse(atob(encodeAvatarOffer(offer))), offer);
  const answer = { type: "answer", sdp: "v=0\r\ns=avatar\r\n" };
  assert.deepEqual(decodeAvatarAnswer(btoa(JSON.stringify(answer))), answer);
  assert.throws(() => encodeAvatarOffer({ type: "answer", sdp: "v=0" }), /invalid avatar SDP offer/i);
  for (const invalid of [
    "not base64!", btoa("not json"), btoa(JSON.stringify(null)),
    btoa(JSON.stringify({ type: "offer", sdp: "v=0" })),
    btoa(JSON.stringify({ type: "answer", sdp: "" })),
  ]) assert.throws(() => decodeAvatarAnswer(invalid), /invalid avatar SDP answer/i);
});
test("avatar mode requires a saved avatar and valid relay settings", () => {
  assert.throws(() => avatarIceServers(null), /no avatar configuration/i);
  assert.throws(() => avatarIceServers({ ice_servers: [] }), /no relay settings/i);
  assert.throws(() => avatarIceServers({ ice_servers: [{ urls: [] }] }), /invalid avatar ICE server/i);
  assert.throws(() => avatarIceServers({ ice_servers: [{ urls: ["turn:relay"], credential: 42 }] }),
    /invalid avatar ICE server credentials/i);
  const relay = { urls: ["turn:relay"], username: "test-user", credential: "test-credential" };
  assert.deepEqual(avatarIceServers({ ice_servers: [relay] }), [relay]);
});
test("avatar ICE gathering accepts candidates on completion or timeout and supports cancellation", async () => {
  class Gatherer extends EventTarget {
    iceGatheringState: RTCIceGatheringState = "gathering";
    localDescription: { type: "offer"; sdp: string };
    constructor(sdp: string) { super(); this.localDescription = { type: "offer", sdp }; }
  }
  const sdp = "v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 1234 typ host\r\n";
  const completed = new Gatherer(sdp);
  completed.iceGatheringState = "complete";
  assert.deepEqual(await waitForAvatarIce(completed), { type: "offer", sdp });
  assert.deepEqual(await waitForAvatarIce(new Gatherer(sdp), 5), { type: "offer", sdp });
  await assert.rejects(waitForAvatarIce(new Gatherer("v=0\r\n"), 5), /no candidates/i);
  const finishing = new Gatherer(sdp);
  const gathering = waitForAvatarIce(finishing, 1000);
  finishing.iceGatheringState = "complete";
  finishing.dispatchEvent(new Event("icegatheringstatechange"));
  assert.deepEqual(await gathering, { type: "offer", sdp });
  const controller = new AbortController();
  const cancelled = waitForAvatarIce(new Gatherer(sdp), 1000, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
});
