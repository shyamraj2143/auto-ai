import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./CallOverlay.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./calls.css", import.meta.url), "utf8");

describe("website call surface parity", () => {
  it("replaces normal incoming acceptance choices with Retry after setup failure", () => {
    expect(source).toContain('failure ? "Retry" : "Accept"');
    expect(source).toContain("!failure && call?.call_type === \"video\"");
    expect(source).toContain('aria-label={failure ? "Retry accepting call" : "Accept call"}');
  });

  it("shows only friendly production errors and keeps diagnostics development-only", () => {
    expect(source).toContain("callFailurePresentation(error, import.meta.env.DEV)");
    expect(source).not.toContain("<span>{error}</span>");
    expect(source).toContain("Copy diagnostics");
  });

  it("guards call controls against duplicate taps and uses the native cyan-blue accept treatment", () => {
    expect(source).toContain("window.setTimeout(() => setControlPending(false), 350)");
    expect(source).toContain("disabled={controlPending}");
    expect(styles).toContain(".incoming-call-actions .accept{background:linear-gradient(145deg,#22d3ee,#2563eb)}");
  });

  it("ends locally on the first click while synchronizing the terminal state in the background", () => {
    const provider = readFileSync(new URL("./CallProvider.tsx", import.meta.url), "utf8");
    expect(provider).toContain("if (endInProgressRef.current || cleanupRunningRef.current || callEndedRef.current) return");
    expect(provider).toContain('sessionStateRef.current = "ending"');
    expect(provider).toContain('signaling.send("call.end"');
    expect(provider).toContain('await cleanup("ended")');
    expect(provider).toContain('return callApi.end(token, currentCall.id, reason)');
  });

  it("bounds media connection recovery and closes the correlated browser notification", () => {
    const provider = readFileSync(new URL("./CallProvider.tsx", import.meta.url), "utf8");
    expect(provider).toContain("CALL_MEDIA_CONNECT_TIMEOUT_MS");
    expect(provider).toContain('"MEDIA_CONNECT_TIMEOUT"');
    expect(provider).toContain("browserNotificationRef.current?.close()");
    expect(provider).toContain("browserNotificationRef.current = notification");
  });

  it("recovers an accepted call when its realtime event was missed during reconnect", () => {
    const provider = readFileSync(new URL("./CallProvider.tsx", import.meta.url), "utf8");
    expect(provider).toContain('setCallTimer("fcmTimeout"');
    expect(provider).toContain("await resumeAcceptedCallRef.current(created.id, authoritative)");
  });
});
