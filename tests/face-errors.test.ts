import { test } from "node:test";
import assert from "node:assert/strict";
import { faceServiceError } from "../server/face-errors.js";

test("Face API endpoint mismatch identifies the resource configuration problem", () => {
  assert.match(faceServiceError(400, "API endpoint does not match resource"), /does not expose the requested Face API/);
  assert.match(faceServiceError(400, "API endpoint does not match resource"), /AZURE_FACE_ENDPOINT/);
});

test("Face API authentication, throttling, and unknown errors stay distinct", () => {
  for (const status of [401, 403]) {
    const message = faceServiceError(status, "PermissionDenied");
    assert.match(message, /access was denied/);
    assert.match(message, /Face data role/);
    assert.match(message, /10 minutes/);
  }
  assert.match(faceServiceError(429, undefined), /busy/);
  assert.equal(faceServiceError(400, "InvalidImageSize"), "Azure Face could not assess this frame (HTTP 400).");
});

test("Face errors include only a valid Azure request ID", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";
  assert.match(faceServiceError(401, "PermissionDenied", requestId), new RegExp(`Azure request ID: ${requestId}`));
  assert.equal(faceServiceError(401, "PermissionDenied", "invalid\r\nheader"), faceServiceError(401, "PermissionDenied"));
});
