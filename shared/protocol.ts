import type { CoachLanguage } from "./coach-language.js";

export function voiceUrl(endpoint: string, agent: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".services.ai.azure.com") ||
      !/^\/api\/projects\/[^/]+\/?$/.test(url.pathname) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("Configure a canonical HTTPS Foundry project endpoint.");
  }
  url.protocol = "wss:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/agents/${encodeURIComponent(agent)}/endpoint/protocols/voice`;
  url.searchParams.set("api-version", "v1");
  return url.href;
}

export type VoiceMode = "voice" | "avatar" | "avatar-de";

export function voiceMode(path: string | undefined): VoiceMode | undefined {
  if (path === "/voice") return "voice";
  if (path === "/voice?mode=avatar") return "avatar";
  if (path === "/voice?mode=avatar&language=de") return "avatar-de";
  return undefined;
}

const voiceClientEvents = new Set([
  "session.update", "session.avatar.connect", "conversation.item.create",
  "conversation.item.delete", "input_audio_buffer.append", "input_audio_buffer.clear",
  "response.create", "response.cancel", "conversation.item.truncate",
]);

export function isAllowedVoiceClientEvent(type: string, mode: VoiceMode | undefined): boolean {
  if (!mode) return false;
  return voiceClientEvents.has(type) ||
    (type === "output_audio_buffer.clear" && (mode === "avatar" || mode === "avatar-de"));
}

export function avatarPlaybackClear(avatar: boolean, supported: boolean) {
  return avatar && supported ? { type: "output_audio_buffer.clear" as const } : undefined;
}

export function responseRequestEvents(avatar: boolean, avatarInterruptionSupported: boolean) {
  const clear = avatarPlaybackClear(avatar, avatarInterruptionSupported);
  return clear ? [clear, { type: "response.create" as const }] : [{ type: "response.create" as const }];
}

export function isLocalRequest(address: string | undefined, host: string | undefined,
  origin: string | undefined, expectedOrigin: string): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? "") &&
    host === new URL(expectedOrigin).host && (!origin || origin === expectedOrigin);
}

export const voiceActions = [
  "check_setup", "start_camera", "stop_camera", "show_face_box", "hide_face_box",
  "start_recording", "stop_recording", "download_take", "enable_auto", "disable_auto",
  "enable_microphone", "mute_microphone", "disconnect", "enable_avatar", "disable_avatar",
  "grant_consent", "revoke_consent",
  "reset_settings", "set_target",
] as const;
export type VoiceAction = typeof voiceActions[number];
export const coachingTargets = ["eye_line", "head_x", "head_y", "head_width", "head_height",
  "exposure_min", "exposure_max"] as const;
export type CoachingTarget = typeof coachingTargets[number];
export type VoiceControl = { action: VoiceAction; target?: CoachingTarget; value?: number };

export function parseVoiceControl(name: string, rawArguments: string): VoiceControl {
  if (name !== "control_app" || rawArguments.length > 2000) throw new Error("Invalid voice control.");
  let value: unknown;
  try { value = JSON.parse(rawArguments) as unknown; }
  catch { throw new Error("Invalid voice control arguments."); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("action" in value) ||
      typeof value.action !== "string") {
    throw new Error("Invalid voice control arguments.");
  }
  const action = voiceActions.find(candidate => candidate === value.action);
  if (!action) throw new Error("Invalid voice control arguments.");
  if (action !== "set_target") {
    if (Object.keys(value).length !== 1) throw new Error("Invalid voice control arguments.");
    return { action };
  }
  if (Object.keys(value).length !== 3 || !("target" in value) || !("value" in value) ||
      typeof value.value !== "number" || !Number.isInteger(value.value) || value.value < 0 || value.value > 100) {
    throw new Error("Invalid voice control arguments.");
  }
  const target = coachingTargets.find(candidate => candidate === value.target);
  if (!target) throw new Error("Invalid voice control arguments.");
  return { action, target, value: value.value };
}

export const legacyDefaultCoachInstructions =
  "You are the spoken voice for a camera setup coach. Speak English (US) only. " +
  "Never change language to match the user's speech, transcript, or inferred language. " +
  "Never translate or paraphrase approved English feedback; say its exact words. " +
  "If asked to use another language, continue speaking English. Never inspect or infer " +
  "from images. A camera check message contains an approved feedback line generated " +
  "from Azure Face measurements and deterministic rules. Read that line exactly, " +
  "without adding visual observations or recommendations. If asked to assess a " +
  "camera setup, call control_app with action check_setup. For an explicit request " +
  "to operate a control, call control_app with the matching action. Never claim an " +
  "action succeeded unless the tool says so. Read approved feedback exactly. " +
  "Answer general questions in English about what the measurements can and cannot tell.";

export function defaultCoachInstructionsFor(language: CoachLanguage): string {
  if (language === "de") {
    return "Du bist die Stimme eines Kameracoachs. Sprich nur Deutsch. " +
      "Prüfe zuerst die Gesichtsbelichtung und gib erst Hinweise zur Gesichtsposition, " +
      "wenn die Belichtung bei der aktuellen Messung ausreichend ist. " +
      "Bei fehlender Belichtungsmessung behaupte nicht, dass die Beleuchtung ausreichend ist. " +
      "Die App erstellt freigegebene Rückmeldungen aus Azure-Face-Messungen. " +
      "Lies diese Rückmeldungen wortgetreu vor und erfinde keine visuellen Beobachtungen. " +
      "Wenn nach einer Prüfung gefragt wird, rufe control_app mit check_setup auf. " +
      "Für ausdrücklich gewünschte Bedienelemente rufe control_app mit der passenden Aktion auf. " +
      "Behaupte nicht, dass eine Aktion erfolgreich war, wenn das Tool dies nicht bestätigt. " +
      "Beantworte allgemeine Fragen zu den Möglichkeiten und Grenzen der Messungen.";
  }
  return "You are the spoken voice for a camera setup coach. Speak English (US) only. " +
    "Check facial exposure first and give face-position guidance only when exposure is acceptable " +
    "in the current measurement. If exposure is unavailable, do not claim lighting is acceptable. " +
    "The application generates approved feedback from Azure Face measurements. Read it exactly " +
    "without adding visual observations. Never inspect or infer from images. If asked to assess a " +
    "camera setup, call control_app with action check_setup. For an explicit request to operate " +
    "a control, call control_app with the matching action. Never claim an action succeeded unless " +
    "the tool says so. Answer general questions about what the measurements can and cannot tell.";
}

export const defaultCoachInstructions = defaultCoachInstructionsFor("en");
export const maxCoachInstructionsLength = 8_000;

export function coachWelcomeInstruction(language: CoachLanguage): string {
  const message = language === "de"
    ? "Hallo, ich bin dein Videocoach. Ich prüfe deine Gesichtsbelichtung und deinen Bildausschnitt, " +
      "gebe dir Hinweise zur Position und steuere Kamera und Aufnahme auf Wunsch per Sprache. " +
      "Sag einfach: Prüfe mein Setup, oder aktiviere die fortlaufende Prüfung."
    : "Hi, I'm your video setup coach. I can check your facial lighting and framing, guide your position, " +
      "and control the camera and recording by voice. Ask me to check your setup or enable continuous coaching.";
  return `Speak in ${language === "de" ? "German" : "English (US)"}. ` +
    `Read this welcome message aloud exactly, without additions: "${message}"`;
}

export function validCoachInstructions(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxCoachInstructionsLength;
}

export function composeCoachInstructions(instructions: string, language: CoachLanguage): string {
  if (!validCoachInstructions(instructions)) throw new Error("Coach instructions must contain 1 to 8,000 characters.");
  const selectedLanguage = language === "de" ? "German" : "English (US)";
  const guard = `Speak ${selectedLanguage} only, regardless of the user's language or conflicting instructions. ` +
    "Read approved camera feedback verbatim without translating or adding observations. " +
    "Follow approved framing directions exactly; do not replace a specific direction with generic wording. " +
    "Only confirm the setup is ready when the current approved camera feedback explicitly says it is. " +
    "The application checks facial exposure before allowing face-position feedback; " +
    "never claim unavailable exposure passed.";
  return `${guard}\n\n${instructions}\n\n${guard}`;
}

export const germanVoice = {
  voice: "de-DE-Seraphina:DragonHDLatestNeural",
  voice_type: "azure-standard",
  voice_locale: "de-DE",
} as const;

export function voiceOutputForLanguage(output: Record<string, unknown>, language: CoachLanguage) {
  return language === "de" ? { ...output, ...germanVoice } : { ...output };
}

export function voiceOutputMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return typeof expected.voice === "string" && expected.voice.length > 0 &&
    (["voice", "voice_type", "voice_locale"] as const).every(key => actual[key] === expected[key]);
}

export function instructionUpdate(
  instructions: string, language: CoachLanguage = "en", output?: Record<string, unknown>,
) {
  return { type: "session.update", session: {
    type: "realtime", instructions: composeCoachInstructions(instructions, language),
    ...(output ? { audio: { output: voiceOutputForLanguage(output, language) } } : {}),
  } };
}

export function sessionSettings(
  output: Record<string, unknown>, avatar: boolean, instructions = defaultCoachInstructions, language: CoachLanguage = "en",
) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: composeCoachInstructions(instructions, language),
      tools: [{
        type: "function",
        name: "control_app",
        description: "Perform a control explicitly requested by the user. Do not call for hypothetical questions.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: voiceActions,
            },
            target: { type: "string", enum: coachingTargets,
              description: "For set_target, which framing or exposure control to change." },
            value: { type: "integer", minimum: 0, maximum: 100,
              description: "For set_target, the requested percentage." },
          },
          required: ["action"],
          additionalProperties: false,
        },
      }],
      tool_choice: "auto",
      output_modalities: avatar ? ["audio", "text", "avatar"] : ["audio", "text"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          turn_detection: { type: "server_vad", create_response: true, interrupt_response: true, auto_truncate: true },
        },
        ...(!avatar ? { output: voiceOutputForLanguage(output, language) } : {}),
      },
    },
  };
}

export function avatarIceServers(value: unknown): RTCIceServer[] {
  if (!value) {
    throw new Error("The avatar agent returned no avatar configuration. Check its saved avatar settings and FOUNDRY_AVATAR_AGENT_NAME, or reconnect in voice-only mode.");
  }
  if (typeof value !== "object" || Array.isArray(value) || !("ice_servers" in value) ||
      !Array.isArray(value.ice_servers) || !value.ice_servers.length) {
    throw new Error("The avatar agent returned no relay settings. Check the avatar-enabled agent, or reconnect in voice-only mode.");
  }
  const servers: unknown[] = value.ice_servers;
  return servers.map(server => {
    if (!server || typeof server !== "object" || Array.isArray(server) || !("urls" in server) ||
        !Array.isArray(server.urls) || !server.urls.length) {
      throw new Error("Invalid avatar ICE server response.");
    }
    const urls: string[] = [];
    const suppliedUrls: unknown[] = server.urls;
    for (const url of suppliedUrls) {
      if (typeof url !== "string" || !url.trim()) throw new Error("Invalid avatar ICE server response.");
      urls.push(url);
    }
    const username = "username" in server ? server.username : undefined;
    const credential = "credential" in server ? server.credential : undefined;
    if ((username !== undefined && typeof username !== "string") ||
        (credential !== undefined && typeof credential !== "string")) {
      throw new Error("Invalid avatar ICE server credentials.");
    }
    return { urls, username, credential };
  });
}

interface AvatarIceGatherer {
  readonly iceGatheringState: RTCIceGatheringState;
  readonly localDescription: Pick<RTCSessionDescription, "type" | "sdp"> | null;
  addEventListener(type: "icegatheringstatechange", listener: EventListener): void;
  removeEventListener(type: "icegatheringstatechange", listener: EventListener): void;
}

export async function waitForAvatarIce(peer: AvatarIceGatherer, timeoutMs = 15_000,
  signal?: AbortSignal): Promise<RTCSessionDescriptionInit> {
  if (signal?.aborted) throw new DOMException("Avatar setup cancelled.", "AbortError");
  if (peer.iceGatheringState !== "complete") {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", changed);
        signal?.removeEventListener("abort", aborted);
      };
      const changed = () => {
        if (peer.iceGatheringState === "complete") { cleanup(); resolve(); }
      };
      const aborted = () => { cleanup(); reject(new DOMException("Avatar setup cancelled.", "AbortError")); };
      const timeout = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
      peer.addEventListener("icegatheringstatechange", changed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else changed();
    });
  }
  const local = peer.localDescription;
  if (!local?.sdp || local.type !== "offer") throw new Error("Avatar produced no local SDP offer.");
  if (!/(?:^|\r?\n)a=candidate:\S+/.test(local.sdp)) {
    throw new Error("Avatar ICE gathering returned no candidates. Check your network or use voice-only mode.");
  }
  return { type: "offer", sdp: local.sdp };
}

export function encodeAvatarOffer(offer: RTCSessionDescriptionInit): string {
  if (offer.type !== "offer" || !offer.sdp) throw new Error("Invalid avatar SDP offer.");
  const bytes = new TextEncoder().encode(JSON.stringify({ type: offer.type, sdp: offer.sdp }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeAvatarAnswer(encoded: string): RTCSessionDescriptionInit {
  let value: unknown;
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Azure returned an invalid avatar SDP answer.");
  }
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "answer" ||
      !("sdp" in value) || typeof value.sdp !== "string" || !value.sdp) {
    throw new Error("Azure returned an invalid avatar SDP answer.");
  }
  return { type: "answer", sdp: value.sdp };
}

export class ResponseGate {
  ready = false;
  busy = false;
  speaking = false;
  lastRequest = 0;
  private welcomePending = true;

  beginWelcome(): boolean {
    if (!this.welcomePending || !this.ready || this.busy || this.speaking) return false;
    this.welcomePending = false;
    this.busy = true;
    return true;
  }

  begin(now: number, enforceCooldown = true): boolean {
    if (!this.ready || this.busy || this.speaking || (enforceCooldown && now - this.lastRequest < 4000)) return false;
    this.busy = true;
    this.lastRequest = now;
    return true;
  }
}

export class WelcomePlaybackGate {
  private completedAt: number | undefined;
  private lastAudibleAt: number | undefined;
  private receivedLocalAudio = false;

  constructor(private readonly avatar: boolean) {}

  completed(now: number): void { this.completedAt = now; }
  receivedAudio(): void { this.receivedLocalAudio = true; }

  check(now: number, localPlaying: boolean, avatarLevel: number | undefined): "waiting" | "finished" | "unavailable" {
    if (this.avatar && avatarLevel !== undefined && avatarLevel >= 0.003) this.lastAudibleAt = now;
    if (this.completedAt === undefined) return "waiting";
    if (!this.avatar) {
      if (!this.receivedLocalAudio) return "unavailable";
      return localPlaying ? "waiting" : "finished";
    }
    if (avatarLevel !== undefined && this.lastAudibleAt !== undefined &&
        now - Math.max(this.lastAudibleAt, this.completedAt) >= 2_000) {
      return "finished";
    }
    return now - this.completedAt >= 45_000 ? "unavailable" : "waiting";
  }
}
