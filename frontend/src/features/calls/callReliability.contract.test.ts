import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { nativeRuntimeOwnsMediaSignal } from "./services/callNative";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("call reliability hotfix", () => {
  it("retries transient native foreground service starts", () => {
    const provider = source("src/features/calls/CallProvider.tsx");
    expect(provider).toContain("retryableNativeServiceCodes");
    expect(provider).toContain("SERVICE_READY_TIMEOUT");
    expect(provider).toContain("attempt < 3");
  });

  it("keeps Android WebRTC signaling exclusively in the native runtime", () => {
    expect(nativeRuntimeOwnsMediaSignal(true, "webrtc.offer")).toBe(true);
    expect(nativeRuntimeOwnsMediaSignal(true, "webrtc.ice_candidate")).toBe(true);
    expect(nativeRuntimeOwnsMediaSignal(true, "call.peer_ready")).toBe(true);
    expect(nativeRuntimeOwnsMediaSignal(false, "webrtc.offer")).toBe(false);
    expect(nativeRuntimeOwnsMediaSignal(true, "call.active")).toBe(false);

    const provider = source("src/features/calls/CallProvider.tsx");
    expect(provider).toContain("native_media_signal_ignored_by_webview");
    expect(provider).toContain("Android's foreground service is the sole signaling/media owner");
  });

  it("does not restart call bootstrap when signaling callbacks change", () => {
    const provider = source("src/features/calls/CallProvider.tsx");
    expect(provider).toContain("processNativeCallActionRef.current");
    expect(provider).toContain("}, [signaling, token, user]);");
    expect(provider).not.toContain("[cleanup, processNativeCallAction, receiveIncomingCall, signaling, token, user]");
  });
});
