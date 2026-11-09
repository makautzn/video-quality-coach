import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCoachingSettings, assessFaces, defaultCoachingSettings, exposureCue, faceDetectUrl, framingCue, FramingCueGate,
  isCoachingSettings, isFaceAssessment,
} from "../shared/face-assessment.js";
import {
  avatarIceServers, avatarPlaybackClear, coachWelcomeInstruction, composeCoachInstructions, decodeAvatarAnswer,
  defaultCoachInstructions, defaultCoachInstructionsFor, encodeAvatarOffer, germanVoice, instructionUpdate,
  isAllowedVoiceClientEvent, isLocalRequest, maxCoachInstructionsLength, parseVoiceControl, responseRequestEvents,
  ResponseGate, sessionSettings,
  validCoachInstructions, voiceMode, voiceOutputForLanguage, voiceOutputMatches, voiceUrl, waitForAvatarIce, WelcomePlaybackGate,
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
  assert.equal(voiceMode("/voice?mode=avatar&language=de"), "avatar-de");
  for (const path of [
    undefined, "/voice/", "/voice?mode=voice", "/voice?agent=other",
    "/voice?mode=avatar&agent=other", "/voice?mode=avatar&mode=voice", "/voice?mode=%61vatar",
    "/voice?language=de", "/voice?mode=avatar&language=en", "/voice?mode=avatar&language=de&agent=other",
    "/voice?mode=avatar&language=de&language=de",
  ]) assert.equal(voiceMode(path), undefined);
});
test("avatar playback can be cleared only on an avatar voice route", () => {
  assert.equal(isAllowedVoiceClientEvent("output_audio_buffer.clear", "avatar"), true);
  assert.equal(isAllowedVoiceClientEvent("output_audio_buffer.clear", "avatar-de"), true);
  assert.equal(isAllowedVoiceClientEvent("output_audio_buffer.clear", "voice"), false);
  assert.equal(isAllowedVoiceClientEvent("output_audio_buffer.clear", undefined), false);
  assert.equal(isAllowedVoiceClientEvent("response.create", "voice"), true);
  assert.equal(isAllowedVoiceClientEvent("unsupported.event", "avatar"), false);
});
test("avatar interruptions clear queued speech before a new response", () => {
  const clear = { type: "output_audio_buffer.clear" };
  const response = { type: "response.create" };
  assert.deepEqual(avatarPlaybackClear(true, true), clear);
  assert.equal(avatarPlaybackClear(false, true), undefined);
  assert.equal(avatarPlaybackClear(true, false), undefined);
  assert.deepEqual(responseRequestEvents(true, true), [clear, response]);
  assert.deepEqual(responseRequestEvents(false, true), [response]);
  assert.deepEqual(responseRequestEvents(true, false), [response]);
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
  ]);
  assert.doesNotMatch(result.spokenText, /headroom|head cut off|distance/i);
});
test("pose, framing, and facial exposure guidance use only present measurements", () => {
  const result = assessFaces([{
    faceRectangle: { left: 274, top: 143, width: 220, height: 120 },
    faceAttributes: { headPose: { yaw: 0, pitch: 30, roll: 16 },
      exposure: { exposureLevel: "goodExposure", value: 0.5 } },
  }], 768, 432);
  assert.deepEqual(result.feedback, [
    "Keep your head a little more level.",
    "Level your head slightly.",
  ]);
  assert.equal(result.exposureLevel, "goodExposure");
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
  const result = assessFaces([{ faceRectangle: { left: 100, top: 110, width: 200, height: 180 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } } }], 768, 432);
  const settings = { ...defaultCoachingSettings, headX: 0.7, headWidth: 0.4 };
  assert.match(applyCoachingSettings(result, settings).spokenText, /Come slightly closer/);
  assert.match(applyCoachingSettings(result, { ...settings, headX: 0.3 }).spokenText, /Move slightly left/);
  assert.match(applyCoachingSettings(result, { ...settings, headWidth: 0.6 }).spokenText, /Come slightly closer/);
  assert.match(applyCoachingSettings(result, { ...settings, headX: 0.74, headWidth: 0.26 }).spokenText,
    /ready to go/);
  assert.equal(isCoachingSettings({ ...settings, headX: 0.85, headWidth: 0.6 }), false);
});
test("continuous framing cues follow the mirrored preview and configured target", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const face = (x: number, y: number, width: number) => ({
    ...assessFaces([{ faceRectangle: { left: 350, top: 170, width: 300, height: 300 },
      faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } } }], 1000, 1000),
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
test("manual and voice-check feedback gives specific framing directions", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const base = assessFaces([{ faceRectangle: { left: 350, top: 350, width: 300, height: 300 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } } }], 1000, 1000);
  const cases = [
    { key: "right", x: 0.7, y: 0.5, width: 0.3, en: /Move slightly right/, de: /nach rechts/ },
    { key: "left", x: 0.3, y: 0.5, width: 0.3, en: /Move slightly left/, de: /nach links/ },
    { key: "down", x: 0.5, y: 0.3, width: 0.3, en: /Move slightly down/, de: /nach unten/ },
    { key: "up", x: 0.5, y: 0.7, width: 0.3, en: /Move slightly up/, de: /nach oben/ },
    { key: "closer", x: 0.5, y: 0.5, width: 0.2, en: /Come slightly closer/, de: /Komm etwas näher/ },
    { key: "back", x: 0.5, y: 0.5, width: 0.4, en: /Move slightly farther/, de: /weiter von der Kamera weg/ },
    { key: "aligned", x: 0.5, y: 0.5, width: 0.3, en: /framing looks good.*ready to go/, de: /Bildausschnitt passt.*loslegen/ },
  ];
  for (const sample of cases) {
    const face = { ...base, faceRectangle: undefined,
      faceCenterX: sample.x, faceCenterY: sample.y, faceWidthRatio: sample.width };
    for (const language of ["en", "de"] as const) {
      const automatic = framingCue(face, settings, language);
      const manual = applyCoachingSettings(face, settings, language);
      assert.equal(automatic.key, sample.key);
      assert.match(manual.spokenText, language === "en" ? sample.en : sample.de);
      assert.equal(manual.spokenText, automatic.text);
      assert.equal(manual.feedback.length, sample.key === "aligned" ? 0 : 1);
    }
  }
});
test("directional framing feedback follows the existing priority even with other findings", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.47, headWidth: 0.29 };
  const base = assessFaces([{ faceRectangle: { left: 645, top: 405, width: 170, height: 250 },
    faceAttributes: {
      exposure: { exposureLevel: "goodExposure", value: 0.5 },
      blur: { blurLevel: "high" },
      headPose: { yaw: 30, pitch: 0, roll: 0 },
    } }], 1000, 1000);
  const first = applyCoachingSettings(base, settings, "de");
  assert.match(first.feedback[0]!, /nach rechts/);
  assert.match(first.feedback[1]!, /unscharf/);
  assert.equal(first.feedback.length, 2);
  const centeredX = { ...base, faceRectangle: undefined, faceCenterX: 0.5 };
  assert.match(applyCoachingSettings(centeredX, settings, "de").feedback[0]!, /nach oben/);
  const centered = { ...centeredX, faceCenterY: settings.headY };
  assert.match(applyCoachingSettings(centered, settings, "de").feedback[0]!, /Komm etwas näher/);
  const aligned = { ...centered, faceWidthRatio: settings.headWidth };
  assert.deepEqual(applyCoachingSettings(aligned, settings, "de").feedback, [
    "Dein Gesicht wirkt unscharf. Halte still und prüfe den Kamerafokus.",
    "Drehe dich etwas mehr zur Kamera.",
  ]);
  const multiple = applyCoachingSettings({ ...base, faceCount: 2 }, settings, "de");
  assert.match(multiple.feedback[0]!, /mehrere Gesichter/);
  assert.match(multiple.feedback[1]!, /nach rechts/);
});
test("directional feedback respects the configured tolerances", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const base = assessFaces([{ faceRectangle: { left: 350, top: 350, width: 300, height: 300 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } } }], 1000, 1000);
  const cue = (x: number, y: number, width: number) => framingCue({
    ...base, faceRectangle: undefined, faceCenterX: x, faceCenterY: y, faceWidthRatio: width,
  }, settings).key;
  assert.equal(cue(0.539, 0.5, 0.3), "aligned");
  assert.equal(cue(0.541, 0.5, 0.3), "right");
  assert.equal(cue(0.459, 0.5, 0.3), "left");
  assert.equal(cue(0.5, 0.549, 0.3), "aligned");
  assert.equal(cue(0.5, 0.551, 0.3), "up");
  assert.equal(cue(0.5, 0.449, 0.3), "down");
  assert.equal(cue(0.5, 0.5, 0.3 * 0.86), "aligned");
  assert.equal(cue(0.5, 0.5, 0.3 * 0.84), "closer");
  assert.equal(cue(0.5, 0.5, 0.3 * 1.14), "aligned");
  assert.equal(cue(0.5, 0.5, 0.3 * 1.16), "back");
});
test("manual and automatic coaching gate framing on the current facial exposure", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const face = assessFaces([{
    faceRectangle: { left: 100, top: 100, width: 200, height: 250 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } },
  }], 1000, 1000);
  for (const [value, category, expected] of [
    [0.24, "goodExposure", "exposure-under"],
    [0.75, "goodExposure", "exposure-over"],
    [null, "underExposure", "exposure-under"],
    [null, "overExposure", "exposure-over"],
    [null, null, "exposure-unavailable"],
  ] as const) {
    const sample = { ...face, exposureValue: value, exposureLevel: category };
    assert.equal(exposureCue(sample, settings).key, expected);
    assert.equal(framingCue(sample, settings).key, expected);
    assert.equal(applyCoachingSettings(sample, settings).spokenText, exposureCue(sample, settings).text);
    assert.doesNotMatch(applyCoachingSettings(sample, settings).spokenText,
      /\b(?:left|right|closer|farther|lower|higher)\b/i);
    assert.equal(framingCue(sample, settings, "de").key, expected);
    assert.equal(applyCoachingSettings(sample, settings, "de").spokenText, exposureCue(sample, settings, "de").text);
    assert.doesNotMatch(applyCoachingSettings(sample, settings, "de").spokenText, /links|rechts|näher|zurück|oben|unten/i);
  }
  assert.equal(exposureCue({ ...face, exposureValue: 0.25 }, settings).key, "exposure-good");
  assert.equal(exposureCue({ ...face, exposureValue: null, exposureLevel: "goodExposure" }, settings).key,
    "exposure-good");
  assert.match(exposureCue({ ...face, exposureValue: null, exposureLevel: "goodExposure" }, settings).text,
    /custom range could not be checked/i);
  assert.equal(framingCue(face, settings).key, "left");
  assert.match(framingCue(face, settings, "de").text, /Belichtung.*nach links/);
  assert.match(applyCoachingSettings(face, settings, "de").spokenText,
    /Belichtung.*nach links/);
  const noFace = assessFaces([], 1000, 1000);
  assert.equal(framingCue(noFace, settings, "de").key, "no-face");
  assert.match(applyCoachingSettings(noFace, settings, "de").spokenText, /kein Gesicht/);
  assert.equal(framingCue({ ...face, exposureValue: 0.1 }, settings).key, "exposure-under");
  assert.equal(framingCue(face, settings).key, "left");
  assert.equal(framingCue({ ...face, exposureValue: 0.9 }, settings).key, "exposure-over");
});
test("ready confirmation requires verified exposure, aligned framing, and no other detected issues", () => {
  const settings = { ...defaultCoachingSettings, headX: 0.5, headY: 0.5, headWidth: 0.3 };
  const face = assessFaces([{
    faceRectangle: { left: 350, top: 350, width: 300, height: 300 },
    faceAttributes: { exposure: { exposureLevel: "goodExposure", value: 0.5 } },
  }], 1000, 1000);
  for (const language of ["en", "de"] as const) {
    const ready = language === "en" ? /ready to go/i : /loslegen/i;
    const manual = applyCoachingSettings(face, settings, language);
    assert.match(manual.spokenText, ready);
    assert.equal(framingCue(face, settings, language).text, manual.spokenText);
    assert.equal(framingCue(face, settings, language).key, "aligned");
    const unverified = { ...face, exposureValue: null };
    assert.equal(framingCue(unverified, settings, language).key, "aligned-unverified");
    assert.doesNotMatch(framingCue(unverified, settings, language).text, ready);
    assert.doesNotMatch(applyCoachingSettings(unverified, settings, language).spokenText, ready);
    for (const sample of [
      { ...face, exposureValue: 0.24 },
      { ...face, exposureValue: 0.75 },
      { ...face, exposureValue: null, exposureLevel: null },
      { ...face, faceRectangle: undefined, faceCenterX: 0.7 },
      { ...face, faceRectangle: undefined, faceCenterY: 0.7 },
      { ...face, faceRectangle: undefined, faceWidthRatio: 0.2 },
      { ...face, faceCount: 2 },
      { ...face, blurLevel: "high" as const },
      { ...face, yawDegrees: 19 },
      { ...face, pitchDegrees: 21 },
      { ...face, rollDegrees: 13 },
      assessFaces([], 1000, 1000),
    ]) {
      assert.doesNotMatch(applyCoachingSettings(sample, settings, language).spokenText, ready);
      assert.doesNotMatch(framingCue(sample, settings, language).text, ready);
    }
  }
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
  const unverified = { key: "aligned-unverified", text: "unverified" };
  gate.spoken(unverified, 1000);
  assert.equal(gate.shouldSpeak(unverified, 100_000), false);
  assert.equal(gate.shouldSpeak(aligned, 9000), true);
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
test("welcome waits for a ready, idle session and is requested only once per connection", () => {
  const gate = new ResponseGate();
  assert.equal(gate.beginWelcome(), false);
  gate.ready = true;
  gate.busy = true;
  assert.equal(gate.beginWelcome(), false);
  gate.busy = false;
  gate.speaking = true;
  assert.equal(gate.beginWelcome(), false);
  gate.speaking = false;
  assert.equal(gate.beginWelcome(), true);
  assert.equal(gate.busy, true);
  assert.equal(gate.begin(1000, false), false);
  gate.busy = false;
  assert.equal(gate.beginWelcome(), false);
  assert.equal(gate.begin(1000, false), true);
  const nextConnection = new ResponseGate();
  nextConnection.ready = true;
  assert.equal(nextConnection.beginWelcome(), true);
});
test("automatic checks wait for welcome playback or report unavailable monitoring", () => {
  const voice = new WelcomePlaybackGate(false);
  assert.equal(voice.check(0, false, undefined), "waiting");
  voice.receivedAudio();
  voice.completed(1000);
  assert.equal(voice.check(1001, true, undefined), "waiting");
  assert.equal(voice.check(1002, false, undefined), "finished");
  const missingVoice = new WelcomePlaybackGate(false);
  missingVoice.completed(1000);
  assert.equal(missingVoice.check(1001, false, undefined), "unavailable");

  const avatar = new WelcomePlaybackGate(true);
  assert.equal(avatar.check(1000, false, 0.02), "waiting");
  avatar.completed(2000);
  assert.equal(avatar.check(3999, false, 0), "waiting");
  assert.equal(avatar.check(4000, false, 0), "finished");

  const delayed = new WelcomePlaybackGate(true);
  delayed.completed(1000);
  assert.equal(delayed.check(2000, false, 0), "waiting");
  assert.equal(delayed.check(2500, false, 0.02), "waiting");
  assert.equal(delayed.check(4499, false, 0), "waiting");
  assert.equal(delayed.check(4500, false, 0), "finished");
  const interruptedMonitor = new WelcomePlaybackGate(true);
  interruptedMonitor.check(1000, false, 0.02);
  interruptedMonitor.completed(1100);
  assert.equal(interruptedMonitor.check(5000, false, undefined), "waiting");
  assert.equal(interruptedMonitor.check(46100, false, undefined), "unavailable");
  const silent = new WelcomePlaybackGate(true);
  silent.completed(1000);
  assert.equal(silent.check(45999, false, undefined), "waiting");
  assert.equal(silent.check(46000, false, undefined), "unavailable");
});
test("welcome describes coaching and voice controls in the selected language", () => {
  const english = coachWelcomeInstruction("en");
  assert.match(english, /^Speak in English \(US\)/);
  assert.match(english, /welcome message aloud exactly/);
  assert.match(english, /facial lighting and framing/);
  assert.match(english, /camera and recording by voice/);
  assert.match(english, /continuous coaching/);
  const german = coachWelcomeInstruction("de");
  assert.match(german, /^Speak in German/);
  assert.match(german, /Gesichtsbelichtung und deinen Bildausschnitt/);
  assert.match(german, /Kamera und Aufnahme.*per Sprache/);
  assert.match(german, /fortlaufende Prüfung/);
});
test("session updates preserve the server's Azure voice instead of resetting its provider", () => {
  const output = { voice: "configured-voice", voice_type: "azure-standard",
    format: { type: "audio/pcm", rate: 24_000 } };
  const event = sessionSettings(output, false);
  assert.deepEqual(event.session.audio.output, output);
  assert.match(event.session.instructions, /Never inspect or infer from images/);
  assert.match(event.session.instructions, /Speak English \(US\) only/);
  assert.match(event.session.instructions, /regardless of the user's language/);
  assert.match(event.session.instructions, /Read approved camera feedback verbatim/);
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
test("German voice-only sessions select and confirm a native German voice without changing avatar output", () => {
  assert.deepEqual(germanVoice, {
    voice: "de-DE-Seraphina:DragonHDLatestNeural",
    voice_type: "azure-standard",
    voice_locale: "de-DE",
  });
  const output = {
    voice: "en-US-Ava:DragonHDLatestNeural", voice_type: "azure-standard", voice_locale: "en-US",
    format: { type: "audio/pcm", rate: 24_000 }, speed: 1,
  };
  const german = { ...output, ...germanVoice };
  assert.deepEqual(voiceOutputForLanguage(output, "en"), output);
  assert.deepEqual(voiceOutputForLanguage(output, "de"), german);
  assert.deepEqual(sessionSettings(output, false, defaultCoachInstructionsFor("de"), "de").session.audio.output, german);
  assert.deepEqual(instructionUpdate("Bitte hilf mir.", "de", output).session.audio, { output: german });
  assert.deepEqual(instructionUpdate("Help me.", "en", output).session.audio, { output });
  assert.equal(voiceOutputMatches(german, germanVoice), true);
  assert.equal(voiceOutputMatches(output, output), true);
  assert.equal(voiceOutputMatches({ ...german, voice: output.voice }, germanVoice), false);
  assert.equal(voiceOutputMatches({ ...german, voice_locale: "en-US" }, germanVoice), false);
  assert.equal(voiceOutputMatches({ ...german, voice_type: "wrong-provider" }, germanVoice), false);
  assert.equal(voiceOutputMatches({}, {}), false);
  assert.equal("output" in sessionSettings(output, true, defaultCoachInstructionsFor("de"), "de").session.audio, false);
  assert.deepEqual(output, {
    voice: "en-US-Ava:DragonHDLatestNeural", voice_type: "azure-standard", voice_locale: "en-US",
    format: { type: "audio/pcm", rate: 24_000 }, speed: 1,
  });
});
test("custom coach instructions are validated and used for both session modes", () => {
  const custom = "Speak concisely and follow the approved camera feedback.";
  assert.equal(sessionSettings({}, false, custom).session.instructions, composeCoachInstructions(custom, "en"));
  assert.equal(sessionSettings({}, true, custom, "de").session.instructions, composeCoachInstructions(custom, "de"));
  assert.deepEqual(instructionUpdate(custom), {
    type: "session.update", session: { type: "realtime", instructions: composeCoachInstructions(custom, "en") },
  });
  assert.match(instructionUpdate(custom, "de").session.instructions, /^Speak German only/);
  assert.match(instructionUpdate(custom).session.instructions, /Follow approved framing directions exactly/);
  assert.match(instructionUpdate(custom, "de").session.instructions, /Follow approved framing directions exactly/);
  assert.match(instructionUpdate(custom).session.instructions, /Only confirm the setup is ready when/);
  assert.match(instructionUpdate(custom, "de").session.instructions, /Only confirm the setup is ready when/);
  assert.match(instructionUpdate(custom, "de").session.instructions, /checks facial exposure before/);
  assert.match(defaultCoachInstructionsFor("de"), /Gesichtsbelichtung/);
  assert.match(defaultCoachInstructionsFor("en"), /facial exposure first/);
  assert.equal(validCoachInstructions(defaultCoachInstructions), true);
  assert.equal(validCoachInstructions("x".repeat(maxCoachInstructionsLength)), true);
  for (const invalid of ["", "  ", "x".repeat(maxCoachInstructionsLength + 1)]) {
    assert.equal(validCoachInstructions(invalid), false);
    assert.throws(() => instructionUpdate(invalid), /Coach instructions/);
    assert.throws(() => sessionSettings({}, true, invalid), /Coach instructions/);
  }
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
