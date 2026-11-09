import type { CoachLanguage } from "./coach-language.js";

export type NormalizedFaceRectangle = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type FaceAssessment = {
  faceCount: number;
  faceRectangle?: NormalizedFaceRectangle | null;
  faceWidthRatio: number | null;
  faceCenterX: number | null;
  faceCenterY: number | null;
  yawDegrees: number | null;
  pitchDegrees: number | null;
  rollDegrees: number | null;
  blurLevel: "low" | "medium" | "high" | null;
  exposureLevel: "underExposure" | "goodExposure" | "overExposure" | null;
  exposureValue?: number | null;
  feedback: string[];
  spokenText: string;
};

export function isFaceAssessment(value: unknown): value is FaceAssessment {
  const result = record(value);
  const faceCount = finite(result.faceCount);
  const faceWidthRatio = finite(result.faceWidthRatio);
  const faceCenterX = finite(result.faceCenterX);
  const faceCenterY = finite(result.faceCenterY);
  const rectangle = record(result.faceRectangle);
  const left = finite(rectangle.left);
  const top = finite(rectangle.top);
  const width = finite(rectangle.width);
  const height = finite(rectangle.height);
  const poseValues = [result.yawDegrees, result.pitchDegrees, result.rollDegrees];
  const emptyMeasurements = faceWidthRatio === null && faceCenterX === null && faceCenterY === null;
  const validFaceMeasurements = faceWidthRatio !== null && faceWidthRatio > 0 && faceWidthRatio <= 1 &&
    faceCenterX !== null && faceCenterX >= 0 && faceCenterX <= 1 &&
    faceCenterY !== null && faceCenterY >= 0 && faceCenterY <= 1;
  const validRectangle = left !== null && left >= 0 && top !== null && top >= 0 &&
    width !== null && width > 0 && height !== null && height > 0 &&
    left + width <= 1 + 1e-9 && top + height <= 1 + 1e-9 &&
    faceWidthRatio !== null && Math.abs(width - faceWidthRatio) < 1e-9 &&
    faceCenterX !== null && Math.abs(left + width / 2 - faceCenterX) < 1e-9 &&
    faceCenterY !== null && Math.abs(top + height / 2 - faceCenterY) < 1e-9;
  const validRectangleForCount = result.faceRectangle === undefined ||
    (faceCount === 0 ? result.faceRectangle === null : validRectangle);
  return faceCount !== null && Number.isInteger(faceCount) && faceCount >= 0 &&
    (faceCount === 0 ? emptyMeasurements : validFaceMeasurements) && validRectangleForCount &&
    poseValues.every(item => item === null || (typeof item === "number" && Number.isFinite(item))) &&
    (result.blurLevel === null || ["low", "medium", "high"].includes(String(result.blurLevel))) &&
    (result.exposureLevel === null ||
      ["underExposure", "goodExposure", "overExposure"].includes(String(result.exposureLevel))) &&
    (result.exposureValue === undefined || result.exposureValue === null ||
      (typeof result.exposureValue === "number" && Number.isFinite(result.exposureValue) &&
       result.exposureValue >= 0 && result.exposureValue <= 1)) &&
    Array.isArray(result.feedback) && result.feedback.every(line => typeof line === "string") &&
    typeof result.spokenText === "string";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}

export type CoachingSettings = {
  eyeLine: number;
  headX: number;
  headY: number;
  headWidth: number;
  headHeight: number;
  exposureMin: number;
  exposureMax: number;
};

export const defaultCoachingSettings: CoachingSettings = {
  eyeLine: 0.33, headX: 0.5, headY: 0.47, headWidth: 0.29, headHeight: 0.6,
  exposureMin: 0.25, exposureMax: 0.75,
};

export function isCoachingSettings(value: unknown): value is CoachingSettings {
  const settings = record(value);
  const ranges: Array<[keyof CoachingSettings, number, number]> = [
    ["eyeLine", 0.1, 0.9], ["headX", 0.15, 0.85], ["headY", 0.15, 0.85],
    ["headWidth", 0.1, 0.6], ["headHeight", 0.2, 0.9],
    ["exposureMin", 0, 0.99], ["exposureMax", 0.01, 1],
  ];
  return ranges.every(([key, min, max]) => {
    const n = finite(settings[key]);
    return n !== null && n >= min && n <= max;
  }) && Number(settings.exposureMin) < Number(settings.exposureMax) &&
    Number(settings.headX) - Number(settings.headWidth) / 2 >= -1e-9 &&
    Number(settings.headX) + Number(settings.headWidth) / 2 <= 1 + 1e-9 &&
    Number(settings.headY) - Number(settings.headHeight) / 2 >= -1e-9 &&
    Number(settings.headY) + Number(settings.headHeight) / 2 <= 1 + 1e-9;
}

export type FramingCue = { key: string; text: string };

const messages = {
  en: {
    noFace: "I couldn't detect a face. Make sure your face is visible and try again.",
    under: "Your face looks underexposed; add a soft light in front of you.",
    over: "Your face looks overexposed; soften or reduce the light on your face.",
    unavailable: "I can't assess facial exposure in this frame. Check your lighting and try again.",
    exposureGood: "Your facial exposure is within the configured range.",
    exposureCategory: "Azure reports good facial exposure; the custom range could not be checked.",
    multiple: "I found multiple faces; make sure your face is the main subject in view.",
    blur: "Your face looks blurry; hold still and check the camera focus.",
    yaw: "Turn a little more toward the camera.",
    pitch: "Keep your head a little more level.",
    roll: "Level your head slightly.",
    right: "Move slightly right in the preview to align your face with the framing guide.",
    left: "Move slightly left in the preview to align your face with the framing guide.",
    down: "Move slightly down in the preview to align your face with the framing guide.",
    up: "Move slightly up in the preview to align your face with the framing guide.",
    closer: "Your face looks small compared with the guide. Come slightly closer to the camera.",
    back: "Your face looks large compared with the guide. Move slightly farther from the camera.",
    aligned: "Your face is close to the framing target.",
    ready: "Your framing looks good. You're ready to go.",
  },
  de: {
    noFace: "Ich konnte kein Gesicht erkennen. Stelle sicher, dass dein Gesicht sichtbar ist, und versuche es erneut.",
    under: "Dein Gesicht ist unterbelichtet. Stelle eine weiche Lichtquelle vor dich.",
    over: "Dein Gesicht ist überbelichtet. Verringere das Licht oder mache es weicher.",
    unavailable: "Ich kann die Gesichtsbelichtung in diesem Bild nicht beurteilen. Prüfe dein Licht und versuche es erneut.",
    exposureGood: "Die Belichtung deines Gesichts liegt im eingestellten Bereich.",
    exposureCategory: "Azure meldet eine gute Gesichtsbelichtung; der eingestellte Bereich konnte nicht geprüft werden.",
    multiple: "Ich habe mehrere Gesichter erkannt. Stelle sicher, dass dein Gesicht im Mittelpunkt steht.",
    blur: "Dein Gesicht wirkt unscharf. Halte still und prüfe den Kamerafokus.",
    yaw: "Drehe dich etwas mehr zur Kamera.",
    pitch: "Halte deinen Kopf etwas gerader.",
    roll: "Richte deinen Kopf etwas gerader aus.",
    right: "Bewege dich in der Vorschau etwas nach rechts, bis dein Gesicht näher an der Markierung ist.",
    left: "Bewege dich in der Vorschau etwas nach links, bis dein Gesicht näher an der Markierung ist.",
    down: "Bewege dich in der Vorschau etwas nach unten, bis dein Gesicht näher an der Markierung ist.",
    up: "Bewege dich in der Vorschau etwas nach oben, bis dein Gesicht näher an der Markierung ist.",
    closer: "Dein Gesicht wirkt im Verhältnis zur Markierung klein. Komm etwas näher an die Kamera.",
    back: "Dein Gesicht wirkt im Verhältnis zur Markierung groß. Geh etwas weiter von der Kamera weg.",
    aligned: "Dein Gesicht ist nahe an der Bildausschnitt-Markierung.",
    ready: "Dein Bildausschnitt passt. Du kannst loslegen.",
  },
} as const;

export function exposureCue(
  assessment: FaceAssessment, settings: CoachingSettings, language: CoachLanguage = "en",
): FramingCue {
  if (!isFaceAssessment(assessment) || !isCoachingSettings(settings)) {
    throw new Error("Invalid face assessment or coaching settings.");
  }
  const text = messages[language];
  if (!assessment.faceCount) return { key: "no-face", text: text.noFace };
  const exposure = assessment.exposureValue;
  if (typeof exposure === "number") {
    if (exposure < settings.exposureMin) return { key: "exposure-under", text: text.under };
    if (exposure >= settings.exposureMax) return { key: "exposure-over", text: text.over };
    return { key: "exposure-good", text: text.exposureGood };
  }
  if (assessment.exposureLevel === "underExposure") return { key: "exposure-under", text: text.under };
  if (assessment.exposureLevel === "overExposure") return { key: "exposure-over", text: text.over };
  if (assessment.exposureLevel === "goodExposure") return { key: "exposure-good", text: text.exposureCategory };
  return { key: "exposure-unavailable", text: text.unavailable };
}

function targetFramingCue(
  assessment: FaceAssessment, settings: CoachingSettings, language: CoachLanguage,
): FramingCue {
  const text = messages[language];
  if (assessment.faceCenterX === null || assessment.faceCenterY === null || assessment.faceWidthRatio === null) {
    throw new Error("Face measurements are missing.");
  }
  const x = (1 - assessment.faceCenterX) - settings.headX;
  const y = assessment.faceCenterY - settings.headY;
  const width = assessment.faceWidthRatio / settings.headWidth;
  if (Math.abs(x) > 0.04) {
    return x < 0
      ? { key: "right", text: text.right }
      : { key: "left", text: text.left };
  }
  if (Math.abs(y) > 0.05) {
    return y < 0
      ? { key: "down", text: text.down }
      : { key: "up", text: text.up };
  }
  if (width < 0.85) return { key: "closer", text: text.closer };
  if (width > 1.15) return { key: "back", text: text.back };
  return { key: "aligned", text: text.aligned };
}

export function framingCue(
  assessment: FaceAssessment, settings: CoachingSettings, language: CoachLanguage = "en",
): FramingCue {
  const exposure = exposureCue(assessment, settings, language);
  if (exposure.key !== "exposure-good") return exposure;
  const cue = targetFramingCue(assessment, settings, language);
  if (cue.key === "aligned") {
    const customized = applyCoachingSettings(assessment, settings, language);
    const key = customized.feedback.length ? `setup:${customized.feedback[0]}` :
      typeof assessment.exposureValue === "number" ? "aligned" : "aligned-unverified";
    return { key, text: customized.spokenText };
  }
  return { ...cue, text: `${exposure.text} ${cue.text}` };
}

export class FramingCueGate {
  private lastKey: string | undefined;
  private lastSpokenAt = 0;

  shouldSpeak(cue: FramingCue, now: number): boolean {
    if (this.lastKey === undefined) return true;
    if (now - this.lastSpokenAt < 8_000) return false;
    if ((cue.key === "aligned" || cue.key === "aligned-unverified") && cue.key === this.lastKey) return false;
    return cue.key !== this.lastKey || now - this.lastSpokenAt >= 15_000;
  }

  spoken(cue: FramingCue, now: number): void {
    this.lastKey = cue.key;
    this.lastSpokenAt = now;
  }

  reset(): void {
    this.lastKey = undefined;
    this.lastSpokenAt = 0;
  }
}

export function applyCoachingSettings(
  assessment: FaceAssessment, settings: CoachingSettings, language: CoachLanguage = "en",
): FaceAssessment {
  const exposure = exposureCue(assessment, settings, language);
  if (exposure.key !== "exposure-good") {
    return { ...assessment, feedback: [exposure.text], spokenText: exposure.text };
  }
  const text = messages[language];
  const framing = targetFramingCue(assessment, settings, language);
  const feedback: string[] = [];
  if (assessment.faceCount > 1) feedback.push(text.multiple);
  if (framing.key !== "aligned") feedback.push(framing.text);
  if (assessment.blurLevel === "high") feedback.push(text.blur);
  if (assessment.yawDegrees !== null && Math.abs(assessment.yawDegrees) > 18) feedback.push(text.yaw);
  if (assessment.pitchDegrees !== null && Math.abs(assessment.pitchDegrees) > 20) feedback.push(text.pitch);
  if (assessment.rollDegrees !== null && Math.abs(assessment.rollDegrees) > 12) feedback.push(text.roll);
  const selected = feedback.slice(0, 2);
  const aligned = typeof assessment.exposureValue === "number" ? text.ready : text.aligned;
  const spokenText = `${exposure.text} ${selected.length ? selected.join(" ") : aligned}`;
  return { ...assessment, feedback: selected, spokenText };
}

export function faceDetectUrl(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error("AZURE_FACE_ENDPOINT must be an HTTPS Azure Face resource endpoint."); }
  if (url.protocol !== "https:" || url.port !== "" ||
      !/^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i.test(url.hostname) ||
      (url.pathname !== "/" && url.pathname !== "") || url.username || url.password || url.search || url.hash) {
    throw new Error("AZURE_FACE_ENDPOINT must be the HTTPS root endpoint of an Azure Face resource.");
  }
  url.pathname = "/face/v1.0/detect";
  url.search = new URLSearchParams({
    detectionModel: "detection_03",
    returnFaceId: "false",
    returnFaceLandmarks: "false",
    returnFaceAttributes: "blur,exposure,headPose",
  }).toString();
  return url.href;
}

export function assessFaces(value: unknown, width: number, height: number): FaceAssessment {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Invalid camera frame dimensions.");
  }
  if (!Array.isArray(value)) throw new Error("Azure Face returned an invalid detection response.");
  if (value.length === 0) {
    const spokenText = "I couldn't detect a face in that frame. Make sure your face is visible and try again.";
    return {
      faceCount: 0, faceRectangle: null, faceWidthRatio: null, faceCenterX: null, faceCenterY: null,
      yawDegrees: null, pitchDegrees: null, rollDegrees: null,
      blurLevel: null, exposureLevel: null, exposureValue: null, feedback: [spokenText], spokenText,
    };
  }

  const primary = record(value[0]);
  const rectangle = record(primary.faceRectangle);
  const left = finite(rectangle.left);
  const top = finite(rectangle.top);
  const faceWidth = finite(rectangle.width);
  const faceHeight = finite(rectangle.height);
  if (left === null || top === null || faceWidth === null || faceHeight === null ||
      left < 0 || top < 0 || faceWidth <= 0 || faceHeight <= 0 ||
      left + faceWidth > width || top + faceHeight > height) {
    throw new Error("Azure Face returned invalid face coordinates.");
  }

  const attributes = record(primary.faceAttributes);
  const headPose = record(attributes.headPose);
  const blur = record(attributes.blur);
  const exposure = record(attributes.exposure);
  const faceWidthRatio = faceWidth / width;
  const faceCenterX = (left + faceWidth / 2) / width;
  const faceCenterY = (top + faceHeight / 2) / height;
  const yawDegrees = finite(headPose.yaw);
  const pitchDegrees = finite(headPose.pitch);
  const rollDegrees = finite(headPose.roll);
  const blurLevel = enumValue(blur.blurLevel, ["low", "medium", "high"] as const);
  const exposureLevel = enumValue(
    exposure.exposureLevel, ["underExposure", "goodExposure", "overExposure"] as const,
  );
  const exposureValue = finite(exposure.value);
  if (exposure.value !== undefined && (exposureValue === null || exposureValue < 0 || exposureValue > 1)) {
    throw new Error("Azure Face returned an invalid exposure value.");
  }
  return applyCoachingSettings({
    faceCount: value.length,
    faceRectangle: { left: left / width, top: top / height, width: faceWidthRatio, height: faceHeight / height },
    faceWidthRatio, faceCenterX, faceCenterY,
    yawDegrees, pitchDegrees, rollDegrees, blurLevel, exposureLevel, exposureValue,
    feedback: [], spokenText: "",
  }, defaultCoachingSettings);
}
