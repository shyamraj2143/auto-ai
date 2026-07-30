import { describe, expect, it } from "vitest";
import { CallSetupError, callFailurePresentation, failureCodeOf } from "./callFailures";

describe("call failure classification", () => {
  it("preserves a typed foreground-service failure", () => {
    expect(failureCodeOf(new CallSetupError("FOREGROUND_SERVICE_FAILED", "service rejected"), "INTERNAL_CALL_ERROR"))
      .toBe("FOREGROUND_SERVICE_FAILED");
  });

  it("uses the controlled fallback for unknown errors", () => {
    expect(failureCodeOf(new Error("socket timeout"), "SIGNALING_TIMEOUT")).toBe("SIGNALING_TIMEOUT");
  });

  it("keeps internal diagnostics out of production-facing failures", () => {
    expect(callFailurePresentation("FOREGROUND_SERVICE_INTERNAL_ERROR: binder failed")).toEqual({
      title: "Calling service could not start",
      message: "AutoAI could not prepare the call. Please retry.",
      permissionRelated: false,
    });
  });

  it("classifies permission and network failures with friendly recovery text", () => {
    expect(callFailurePresentation("Microphone permission denied")).toMatchObject({
      title: "Calling permission required",
      permissionRelated: true,
    });
    expect(callFailurePresentation("SIGNALING_TIMEOUT", true)).toMatchObject({
      title: "Connection interrupted",
      diagnostic: "SIGNALING_TIMEOUT",
    });
  });
});
