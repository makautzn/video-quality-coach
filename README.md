# Frame: video setup coach

Frame is a local web prototype that records video and gives spoken, hands-free
feedback on camera framing and facial exposure. It combines a Microsoft Foundry
Voice Agent with Azure Face Detect; an optional talking avatar delivers the same
feedback. Recordings stay in the browser until downloaded.

> **Prototype status:** Face-backed coaching, voice controls, continuous
> sampling, and an Adrian/Andrew avatar are implemented. Synthetic browser
> and WebRTC checks have exercised the integration, but real-device speech,
> playback, coaching accuracy, and user acceptance still require validation.
> This is not a production or multi-user server.

## What it does

- Preview a mirrored camera feed with adjustable head and eye-line guides.
- Check a snapshot manually or opt in to continuous checks approximately
  every 3.5 seconds. The coach gives brief directions relative to the preview
  and spaces out repeated speech.
- Use voice commands such as “check my setup”, “enable automatic checks”,
  “show the face box”, “start recording”, or “set the eye line to 35 percent”.
- Optionally show the face rectangle from the latest checked snapshot, and
  choose an avatar or voice-only coach.
- Record, replay, and download a local camera and microphone take. The avatar
  is not included in the recording.

The coach is instructed to speak English (US) and repeat approved feedback
verbatim; model instructions are not a guarantee of speech behavior. The
microphone starts after connecting and browser permission is granted. Once it
is muted, or the coach is disconnected, use the UI to resume listening.

## Prerequisites

- Node.js 22.18 or later and npm.
- A modern browser with camera and microphone support.
- Azure CLI, signed in with access to the intended subscription.
- A Microsoft Foundry project with a deployed Voice Agent. Its realtime voice
  endpoint and configured voice must be available to the signed-in identity.
- An Azure Face resource with Face Detect enabled and a suitable data-plane
  role for the signed-in identity, such as **Cognitive Services Face
  Recognizer**. An endpoint alone does not prove Face Detect is available.
- For avatar mode, a separate avatar-enabled Voice Agent with a saved avatar
  preset and a working WebRTC connection. Voice-only mode does not require it.

Azure voice, Face requests, and avatar usage can incur charges. Service and
avatar availability depend on the subscription and region.

## Run locally

```powershell
git clone https://github.com/makautzn/video-quality-coach.git
Set-Location video-quality-coach
npm ci
Copy-Item .env.example .env
# Edit .env with your own Azure resources, then sign in if needed:
az login
npm run dev
```

Do not overwrite an existing `.env`. Open **http://127.0.0.1:5173**; use the
exact loopback address rather than `localhost`, because the proxy validates
the origin. `npm run dev` builds the TypeScript and starts the server.

| `.env` setting | Purpose |
|---|---|
| `FOUNDRY_PROJECT_ENDPOINT` | Project endpoint, e.g. `https://<account>.services.ai.azure.com/api/projects/<project>`. |
| `FOUNDRY_VOICE_AGENT_NAME` | Name of the deployed voice-only agent. |
| `FOUNDRY_AVATAR_AGENT_NAME` | Optional name of a **different**, avatar-enabled agent; leave blank to disable avatar mode. |
| `AZURE_SUBSCRIPTION_ID` | Subscription to use for Azure CLI credential requests; leave blank to use the CLI's selected subscription. |
| `AZURE_FACE_ENDPOINT` | HTTPS root endpoint of the Face resource, e.g. `https://<resource>.cognitiveservices.azure.com/`. |
| `PORT` | Local server port; defaults to `5173`. |

The example configuration contains no credentials or real resource endpoints.
Do not commit `.env` or Azure CLI credentials. The app obtains access tokens
through `AzureCliCredential`; a configured endpoint does not itself verify
access. Local camera preview and recording can work without Azure; connecting
the coach and checking a frame require the corresponding resources.

`azure.yaml` contains the prototype's managed Voice Agent definitions,
including the separate avatar preset. It is a deployment template, not proof
that agents exist in a new project. Bind Azure Developer CLI to your own
project and deploy the intended service before using it. Local application
changes do not automatically redeploy an agent. The app supplies its own
grounded instructions when a voice session starts. See the
[Foundry Voice Agent documentation](https://learn.microsoft.com/azure/foundry/agents/how-to/configure-voice-agent)
for current deployment and availability requirements.

## Using the coach

1. Start the camera and adjust the framing guides.
2. Select the avatar if desired, grant consent for Azure processing, and connect.
   Allow microphone access when the browser asks.
3. Say “check my setup” or use **Check my setup** for a snapshot. To keep
   checking, enable **Continuous framing coach** or ask the coach to enable
   automatic checks.
4. Optionally show the face box. It reflects the latest checked snapshot, not
   live tracking, and is not included in the recording.
5. Record a take, stop it, and download it before refreshing or closing the
   page. A completed take is held in browser memory, not automatically saved.

Automatic checks run only while the tab is visible, the camera is running,
consent is enabled, and the coach is connected. Checks do not overlap; service
latency can make the interval longer. The Face free tier permits 20 requests
per minute and 30,000 per month across the resource. At a sustained 3.5-second
interval, the app can consume about 1,029 requests per hour; other applications
and manual checks share the quota. A one-second interval would exceed the free
tier's rate limit. See [Face pricing](https://azure.microsoft.com/pricing/details/cognitive-services/face-api/)
for current quotas and pricing.

The face box clears when a check fails or finds no face, the session or camera
stops, consent is revoked, or the camera dimensions change. Framing settings
are saved in browser local storage and are scoped to the page origin, including
its port. Only one voice control is executed per turn; browser permission and
download prompts can still require a physical interaction.

## How it works

1. The browser captures a JPEG snapshot at up to 768 pixels wide.
2. A loopback-only Node.js proxy sends the image to Azure Face Detect with
   `detection_03`, `returnFaceId=false`, and blur, exposure, and head-pose
   attributes. It does not log or persist the frame.
3. Deterministic local rules compare the returned measurements with the
   configured guide and exposure thresholds. Only approved feedback text,
   not the camera image, is sent to the Foundry Voice Agent.
4. The voice agent reads the feedback. In avatar mode, audio and video arrive
   through WebRTC; voice-only mode uses the realtime voice connection.

Microphone audio is sent to Foundry while listening. The application sets
`store: false` for its agent definitions, but that and `returnFaceId=false`
are not blanket promises about Azure service retention, abuse monitoring, or
separately configured tracing. Review the services' privacy terms and your
own configuration before use. Revoking consent disconnects the coach; it does
not stop an independently running local recording.

## Measurement limits

- Face center and width are approximate framing proxies, not physical distance
  or full-head geometry. Eye line and head height are visual guides only.
- Face Detect does not reliably measure the top of the head, so the app does
  not score headroom or claim a head is clipped.
- Exposure thresholds use Azure's facial exposure score, not a room light
  meter. If its numeric value is unavailable, the app reports that the custom
  thresholds could not be applied and falls back to the service category.
- A still frame cannot establish scene backlighting, video motion quality,
  audio quality, or a person's identity, health, or other sensitive traits.
  No detected face is insufficient evidence, not a lighting diagnosis.

The UI reports time to first **received output**, not first audible audio or
first avatar video. Feedback heuristics and the avatar's usefulness require
calibration and real-user testing.

## Development and evaluation

```powershell
npm test
```

The suite builds TypeScript and tests request validation, deterministic Face
feedback, framing cues, session controls, server restrictions, and avatar
negotiation helpers. It does not prove live Azure access or real-device
audio/video behavior.

`evals/` contains historical generated scenario and rubric examples, **not
completed evaluations**. Some describe image reasoning, backlighting, or
headroom that the current Face-backed implementation cannot perform. Do not
use them as acceptance criteria without replacing them with measurement-based
fixtures and reviewing the rubric. Project-specific Foundry metadata is
excluded; the generated example files remain under `evals/`.

## References

- [Introducing voice agents in Microsoft Foundry](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-voice-agents-in-microsoft-foundry/4557276)
- [Configure a Foundry voice agent](https://learn.microsoft.com/azure/foundry/agents/how-to/configure-voice-agent)
- [Azure Face detection concepts and attributes](https://learn.microsoft.com/azure/ai-services/face/concept-face-detection)
- [Real-time avatar requirements](https://learn.microsoft.com/azure/ai-services/speech-service/text-to-speech-avatar/real-time-synthesis-avatar)
