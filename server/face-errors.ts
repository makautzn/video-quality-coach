export function faceServiceError(status: number, code: string | undefined, requestId?: string | null): string {
  let message: string;
  if (status === 400 && code?.trim().toLowerCase() === "api endpoint does not match resource") {
    message = "The configured Azure resource does not expose the requested Face API. " +
      "Set AZURE_FACE_ENDPOINT to a Face-enabled resource and restart the local server.";
  } else if (status === 401 || status === 403) {
    message = "Azure Face access was denied. Check the endpoint, the signed-in account's Face data role, " +
      "and service access. New role assignments can take up to 10 minutes to take effect.";
  } else if (status === 429) {
    message = "Azure Face is busy. Wait a moment and try again.";
  } else {
    message = `Azure Face could not assess this frame (HTTP ${status}).`;
  }
  if (requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    message += ` Azure request ID: ${requestId}.`;
  }
  return message;
}
