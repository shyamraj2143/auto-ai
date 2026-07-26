import { describe, expect, it } from "vitest";
import { CallSetupError, failureCodeOf } from "./callFailures";

describe("call failure classification", () => {
  it("preserves a typed foreground-service failure", () => {
    expect(failureCodeOf(new CallSetupError("FOREGROUND_SERVICE_FAILED", "service rejected"), "INTERNAL_CALL_ERROR"))
      .toBe("FOREGROUND_SERVICE_FAILED");
  });

  it("uses the controlled fallback for unknown errors", () => {
    expect(failureCodeOf(new Error("socket timeout"), "SIGNALING_TIMEOUT")).toBe("SIGNALING_TIMEOUT");
  });
});
