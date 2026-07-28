import { describe, expect, it } from "vitest";
import { canResumeAcceptedCall, nativeCallRestoreMode, requiresAcceptRequest } from "./callAcceptance";

describe("call acceptance state", () => {
  it.each(["initiated", "ringing", "accepted", "connecting", "active"])("allows safe resume from %s", (status) => {
    expect(canResumeAcceptedCall({ status } as never)).toBe(true);
  });

  it("does not submit a duplicate Accept after native acceptance", () => {
    expect(requiresAcceptRequest({ status: "accepted" } as never)).toBe(false);
    expect(requiresAcceptRequest({ status: "ringing" } as never)).toBe(true);
  });

  it.each(["rejected", "cancelled", "missed", "failed", "ended"])("rejects terminal state %s", (status) => {
    expect(canResumeAcceptedCall({ status } as never)).toBe(false);
  });

  it.each(["accepted", "connecting", "active"])("routes %s directly to accepted-call resume", (status) => {
    expect(nativeCallRestoreMode(status, "resume_call")).toBe("resume");
  });

  it("never converts a stale resume notification into a ringing or blank-home handoff", () => {
    expect(nativeCallRestoreMode("ended", "resume_call")).toBe("terminal");
    expect(nativeCallRestoreMode("ringing", "resume_call")).toBe("ringing");
  });
});
