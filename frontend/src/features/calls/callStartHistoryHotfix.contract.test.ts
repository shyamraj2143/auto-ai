import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const callApiSource = readFileSync(new URL("./services/callApi.ts", import.meta.url), "utf8");
const callsPageSource = readFileSync(new URL("./CallsPage.tsx", import.meta.url), "utf8");
const callsTabSource = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
const providerSource = readFileSync(new URL("./CallProvider.tsx", import.meta.url), "utf8");

describe("call start and recent-history hotfix", () => {
  it("retries TURN credentials and defers a WebView-only failure to the Android native call service", () => {
    expect(callApiSource).toContain("TURN_PREFLIGHT_ATTEMPTS = 3");
    expect(callApiSource).toContain('Capacitor.getPlatform() === "android"');
    expect(callApiSource).toContain('provider: "android-native-deferred"');
    expect(callApiSource).toContain("lastSuccessfulTurnCredentials");
    expect(callApiSource).toContain('operation: "calls.turn"');
  });

  it("caches only an authenticated TURN relay response, never a STUN-only response", () => {
    expect(callApiSource).toContain("function hasUsableTurnRelay");
    expect(callApiSource).toContain('/^turns?:/i.test(url)');
    expect(callApiSource).toContain("if (!relayConfigured) return false");
    expect(callApiSource).toContain("if (hasUsableTurnRelay(credentials)) lastSuccessfulTurnCredentials = credentials");
  });

  it("does not block Android calls on the WebView signaling gate", () => {
  expect(callsTabSource).toContain('import { callNative } from "./services/callNative";');
  expect(callsTabSource).toContain("if (callNative.isAndroid())");
  expect(callsTabSource).toContain("await startCall(user, type);");
  expect(callsTabSource.indexOf("if (callNative.isAndroid())")).toBeLessThan(
    callsTabSource.indexOf('showToast("Connecting secure call service…")'),
  );
});

  it("keeps the real backend call creation and history endpoints as the source of truth", () => {
    expect(callApiSource).toContain('apiFetch<CallRecord>("/calls"');
    expect(callApiSource).toContain('apiFetch<CallHistoryPage>(`/calls/history?page=${page}&limit=${limit}`');
    expect(callsTabSource).toContain("callApi.history(token, 1, 20)");
  });

  it("does not mislabel an immediate delivery race as an offline user", () => {
    expect(providerSource).toContain('created.delivery === "unreachable"');
    expect(providerSource).toContain('callDebug("call_delivery_pending"');
    expect(providerSource).not.toContain('source: "delivery_unreachable"');
    expect(providerSource).not.toContain('cleanup("failed", "User is offline or has no internet connection.")');
  });

  it("recovers an incoming call after push-token repair or socket reconnect", () => {
    expect(callApiSource).toContain('apiFetch<CallRecord | null>("/calls/pending-incoming"');
    expect(providerSource).toContain("callApi.pendingIncoming(token)");
    expect(providerSource).toContain("receiveIncomingCall(pending.id)");
  });

  it("refreshes history immediately whenever the Calls section is opened", () => {
    expect(callsPageSource).toContain('if (section === "calls") setRefreshRequestId');
    expect(callsPageSource).toContain("useEffect, useState");
    expect(callsPageSource).toContain("refreshRequestId={refreshRequestId}");
    expect(providerSource).toContain('new Event("auto-ai-call-history-updated")');
    expect(callsTabSource).toContain('window.addEventListener("auto-ai-call-history-updated", reload)');
    expect(callsTabSource).toContain('if (view === "calls") void loadCallHistory()');
  });
});
