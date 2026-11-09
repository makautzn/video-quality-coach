# Frame: video setup coach

Frame is a local web prototype that records video and gives spoken, hands-free
feedback on camera framing and facial exposure. It combines a Microsoft Foundry
Voice Agent with Azure Face Detect; an optional talking avatar delivers the same
feedback. Recordings stay in the browser until downloaded.

> **Prototype status:** Face-backed coaching, voice controls, continuous
> sampling, and Leonie Casual (VASA-2 preview) avatars are implemented.
> Synthetic browser checks exercised voice-only and avatar sessions, audio/video
> delivery, and the setup-check tool. Real-device speech, voice quality,
> coaching accuracy, and user acceptance still require validation. This is not
> a production or multi-user server.

## What it does

- Preview a mirrored camera feed with adjustable head and eye-line guides.
- Check a snapshot manually or opt in to continuous checks approximately
  every 3.5 seconds. Each snapshot checks facial exposure first; framing
  guidance follows only when exposure is acceptable. The coach gives
  measurement-based directions to move in the preview or adjust distance, and
  spaces out repeated speech.
- Hear a brief introduction when the voice coach or avatar connects. The coach
  confirms you are ready when measured exposure is within your configured range,
  framing matches the guide, and no other detected issue needs correction.
  Continuous coaching waits for the introduction to finish and does not repeat
  the ready confirmation while you remain aligned. If welcome playback cannot
  be verified, automatic checks turn off and the app reports an error.
- Use voice commands such as “check my setup”, “enable automatic checks”,
  “show the face box”, “start recording”, or “set the eye line to 35 percent”.
- Optionally show the face rectangle from the latest checked snapshot, and
  choose an avatar or voice-only coach.
- Record, replay, and download a local camera and microphone take. The avatar
  is not included in the recording.

Choose English (US) or German for the coach in **Coach instructions**. The
included definitions use the female voice `en-US-Ava:DragonHDLatestNeural` for
English and `de-DE-Seraphina:DragonHDLatestNeural` for German. Both avatar
agents use the Leonie casual photo avatar on the preview-only VASA-2 model. The
coach is instructed to speak the selected language and repeat approved feedback
verbatim; model instructions are not a guarantee of speech behavior. The
microphone starts after connecting and browser permission is granted. Once it
is muted, or the coach is disconnected, use the UI to resume listening.

## Azure services

| Service | How Frame uses it |
|---|---|
| **Microsoft Foundry project and Agent Service** | Hosts the managed Voice Agent, its `gpt-realtime` conversation model, voice sessions, and tool calls. The managed model does not need a separate model deployment in your project. |
| **Azure Face** | Face Detect processes each consented JPEG snapshot and returns face position, head pose, blur, and facial exposure measurements. The app does not request face IDs or recognition. |
| **Azure Speech voices and optional avatar** | The Foundry Voice Agents use Azure neural voices. Optional Leonie avatar agents stream synchronized video and audio to the browser over WebRTC. The app does not configure a separate Speech endpoint or key. |
| **Microsoft Entra ID and Azure CLI** | The local proxy uses the signed-in Azure CLI identity to obtain tokens for Foundry and Face; it does not put Azure credentials in the browser. |

The web server and recordings run locally. This repository does not provision
an application host, database, or storage account. Foundry may use its own
platform-managed resources. Voice, Face, and avatar usage can incur charges;
availability and quotas depend on your subscription and region.

## Deploy and run from a fresh clone

These steps use an **existing** Foundry project and a separate Face resource.
They deploy the managed Voice Agent definitions in `azure.yaml`; they do not
create the Foundry project or Face resource. Voice-only mode is the simplest
starting point. Avatar deployment is optional.

### 1. Prerequisites and Azure resources

- Install Node.js 22.18 or later, npm, [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli),
  and [Azure Developer CLI (`azd`)](https://learn.microsoft.com/azure/developer/azure-developer-cli/install-azd).
  Use a modern browser with a camera and microphone.
- Create or use a [Microsoft Foundry project](https://learn.microsoft.com/azure/foundry/how-to/create-projects)
  with access to managed Voice Agents and `gpt-realtime`. Your identity needs
  **Foundry User** on the project or equivalent agent create/update and use
  permissions. Record its project endpoint and full Azure resource ID from
  the Foundry/Azure portal.
- Create or use an [Azure Face resource](https://portal.azure.com/#create/Microsoft.CognitiveServicesFace).
  Record its resource endpoint and grant your signed-in identity a suitable
  data-plane role, such as **Cognitive Services Face Recognizer**. Verify that
  Face Detect and the requested attributes are available to your subscription;
  an endpoint alone does not prove access.
- For Leonie, use a project and subscription with access to the VASA-2 avatar
  preview and a browser/network that supports WebRTC. Voice-only mode does not
  require avatar access. Preview availability is regional and can change.

The following examples use PowerShell. Replace every placeholder with your own
values. Run interactive sign-in commands yourself.

### 2. Clone and bind the project

```powershell
git clone https://github.com/makautzn/video-quality-coach.git
Set-Location video-quality-coach
npm ci

az login --tenant "<tenant-id>"
az account set --subscription "<subscription-id>"
azd auth login --tenant-id "<tenant-id>"
azd extension install microsoft.foundry
azd extension install azure.ai.projects
azd extension install azure.ai.agents

azd env new video-coach-dev
azd env set AZURE_SUBSCRIPTION_ID "<subscription-id>"
azd env set AZURE_TENANT_ID "<tenant-id>"
azd env set AZURE_AI_PROJECT_ID "<full-project-resource-id>"
azd env set AZURE_AI_PROJECT_ENDPOINT "https://<account>.services.ai.azure.com/api/projects/<project>"
```

The `azd` environment is local to this checkout and is excluded from Git.
Use the **same project** for the endpoint and resource ID. Azure CLI and
`azd` maintain separate sign-ins; both identities must have access to the
selected subscription and project. The manifest resolves the project endpoint
from the selected `azd` environment instead of targeting the author's project.

### 3. Deploy the voice agent

```powershell
# Required by azd versions where Voice Agent support is still in preview.
$env:AZD_ALPHA_ENABLE_AGENTS_VOICE = "true"
# Preview should say that the existing Foundry project needs no provisioning.
azd provision --preview --no-prompt
azd deploy video-quality-coach --no-prompt
```

This creates an agent version and can incur Azure charges. It does not deploy
the local web app. If you already have a compatible Voice Agent, you can skip
deployment and configure its name instead. The app sends its own instructions,
tools, language, and approved feedback when a session starts.

For the optional Leonie avatar, deploy the language-specific agents you need:

```powershell
azd deploy video-coach-avatar-check-abc06568 --no-prompt  # English
azd deploy video-coach-avatar-de-abc06568 --no-prompt     # German
```

The suffixes are historical agent names, not values tied to a subscription.
They are retained so existing deployments can be updated rather than silently
creating new agents. The app requires separate agent names for voice-only,
English avatar, and German avatar modes. Deploying a new version can update an
existing agent with the same name in your chosen project.

### 4. Configure and start the local app

Copy the example only if `.env` does not already exist:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
# Edit .env using the settings below, then:
npm run dev
```

Set `FOUNDRY_PROJECT_ENDPOINT` to the same project endpoint used above,
`FOUNDRY_VOICE_AGENT_NAME` to `video-quality-coach`, and
`AZURE_FACE_ENDPOINT` to your Face resource endpoint. Set the optional avatar
agent names to the deployed service names above, or leave them blank. These app
settings are separate from the `azd` environment. Do not overwrite an existing
`.env` or commit it.

Open **http://127.0.0.1:5173**; use the exact loopback address rather than
`localhost`, because the proxy validates the origin. `npm run dev` builds the
TypeScript and starts the server. If `PORT` is changed, use that port in the URL.

| `.env` setting | Purpose |
|---|---|
| `FOUNDRY_PROJECT_ENDPOINT` | Project endpoint, e.g. `https://<account>.services.ai.azure.com/api/projects/<project>`. |
| `FOUNDRY_VOICE_AGENT_NAME` | Name of the deployed voice-only agent. |
| `FOUNDRY_AVATAR_AGENT_NAME` | Optional name of a **different**, English Leonie/avatar-enabled agent; leave blank to disable the English avatar. |
| `FOUNDRY_AVATAR_DE_AGENT_NAME` | Optional name of a separate Leonie/avatar-enabled agent configured with a German voice. Required for the German avatar. |
| `AZURE_SUBSCRIPTION_ID` | Subscription to use for Azure CLI credential requests; leave blank to use the CLI's selected subscription. |
| `AZURE_FACE_ENDPOINT` | HTTPS root endpoint of the Face resource, e.g. `https://<resource>.cognitiveservices.azure.com/`. |
| `PORT` | Local server port; defaults to `5173`. |

The example configuration contains no credentials or real resource endpoints.
Do not commit `.env` or Azure CLI credentials. The app obtains access tokens
through `AzureCliCredential`; a configured endpoint does not itself verify
access. Local camera preview and recording can work without Azure; connecting
the coach and checking a frame require the corresponding resources.

Local changes to `azure.yaml` do not automatically redeploy an agent. To verify
your setup, connect in voice-only mode, allow the browser permissions, and run a
setup check. Try each deployed avatar language separately. If a service rejects
access, verify the project and Face endpoints, selected subscription, roles,
regional availability, and any required limited-access approval. For avatar
connection failures, also check WebRTC connectivity and the saved agent preset.
See the [Foundry Voice Agent documentation](https://learn.microsoft.com/azure/foundry/agents/how-to/configure-voice-agent)
for current requirements.

## Using the coach

1. Start the camera and adjust the framing guides.
2. Select the avatar if desired, grant consent for Azure processing, and connect.
   Allow microphone access when the browser asks.
3. Say “check my setup” or use **Check my setup** for a snapshot. To keep
   checking, enable **Continuous setup coach** or ask the coach to enable
   automatic checks.
4. Optionally show the face box. It reflects the latest checked snapshot, not
   live tracking, and is not included in the recording.
5. Record a take, stop it, and download it before refreshing or closing the
   page. A completed take is held in browser memory, not automatically saved.

Open **Coach instructions** to select English or German and edit the session
instructions. Choose **Apply language & instructions** to save both in this
browser and, when connected, update the current voice session. Switching
languages replaces the built-in default with the corresponding translated
default; custom text is preserved. Restoring the default fills the editor for
the selected language; choose Apply to use it. A voice-only session updates its
voice in place. Switching language during an avatar session reconnects to the
agent configured for that language; the local camera and recording continue,
and the prior microphone mute state is preserved. Changes are scoped to this
page's origin and do not modify the deployed agent.

The app adds language and grounding instructions around the editable text.
Manual, voice-triggered, and automatic checks generate approved feedback in
the selected language and ask the coach to repeat it exactly. The rules first
evaluate facial exposure on the current snapshot; underexposure, overexposure,
missing exposure, or no face blocks position guidance until a later snapshot
has acceptable exposure. The same applies if the light worsens again. Once
exposure is acceptable, checks compare the face center and width with the
configured guide. If the face is outside the target, the coach gives specific
left, right, up, down, closer, or farther guidance. Left and right refer to the
mirrored preview. Face-width comparison is an approximate framing cue, not a
physical distance measurement. Manual
and voice-triggered checks can also report a separate blur or pose issue. If
Azure supplies only an exposure category, the app uses that category and
states that custom thresholds could not be checked. Language and grounding
instructions are model guidance, not a guarantee of voice behavior; pronunciation
and recognition quality should be checked on the actual device in both languages.

When you start speaking or request another response in avatar mode, the app
clears queued avatar speech so an earlier response does not continue over the
next one. Automatic checks wait for the welcome; avatar playback completion is
estimated from audio silence, so an unusually long pause can be mistaken for
the end of speech. Headphones help prevent speaker audio from being picked up by the
microphone; browser echo cancellation is not guaranteed. Disconnect any other
active app or Foundry Playground voice sessions to avoid competing coaches.

Automatic checks run only while the tab is visible, the camera is running,
consent is enabled, and the coach is connected. Checks do not overlap; service
latency can make the interval longer. At a sustained 3.5-second interval, the
app can consume about 1,029 requests per hour; other applications and manual
checks share the resource's quota. See [Face pricing](https://azure.microsoft.com/pricing/details/cognitive-services/face-api/)
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
