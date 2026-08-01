import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const callApiSource = readFileSync(new URL("./services/callApi.ts", import.meta.url), "utf8");
const callsPageSource = readFileSync(new URL("./CallsPage.tsx", import.meta.url), "utf8");
const callsTabSource = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");

describe("call start and recent-history hotfix", () => {
  it("retries TURN credentials and defers a WebView-only failure to the Android native call service", () => {
    expect(callApiSource).toContain("TURN_PREFLIGHT_ATTEMPTS = 3");
    expect(callApiSource).toContain('Capacitor.getPlatform() === "android"');
    expect(callApiSource).toContain('provider: "android-native-deferred"');
    expect(callApiSource).toContain("lastSuccessfulTurnCredentials");
    expect(callApiSource).toContain('operation: "calls.turn"');
  });

  it("keeps the real backend call creation and history endpoints as the source of truth", () => {
    expect(callApiSource).toContain('apiFetch<CallRecord>("/calls"');
    expect(callApiSource).toContain('apiFetch<CallHistoryPage>(`/calls/history?page=${page}&limit=${limit}`');
    expect(callsTabSource).toContain("callApi.history(token, 1, 20)");
  });

  it("refreshes history immediately whenever the Calls section is opened", () => {
    expect(callsPageSource).toContain('if (section === "calls") setRefreshRequestId');
    expect(callsPageSource).toContain("useEffect, useState");
    expect(callsPageSource).toContain("refreshRequestId={refreshRequestId}");
  });
});
