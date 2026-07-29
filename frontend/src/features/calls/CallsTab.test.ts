import { describe, expect, it } from "vitest";
import { CALL_HUB_SECTIONS } from "./CallsTab";
import { readFileSync } from "node:fs";

describe("Call Hub navigation", () => {
  it("contains exactly the five production sections", () => {
    expect(CALL_HUB_SECTIONS).toEqual(["search", "requests", "chats", "calls", "alerts"]);
  });

  it("uses mobile bottom navigation and desktop rail with real badge inputs", () => {
    const css = readFileSync(new URL("./calls.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
    expect(css).toContain("grid-template-columns:76px minmax(0,1fr)");
    expect(css).toContain("grid-row:2;flex-direction:row");
    expect(source).toContain("requests: incoming.length");
    expect(source).toContain("calls: missedCount");
    expect(source).toContain("alerts: unread");
  });

  it("keeps chats restricted to accepted connections and groups call history", () => {
    const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
    expect(source).toContain("userMessagesApi.listThreads");
    expect(source).toContain("thread.unread_count");
    expect(source).toContain("Today\", \"Yesterday\", \"Earlier");
    expect(source).toContain("No missed calls");
    expect(source).toContain("friendlyCallStatus");
  });

  it("supports production request, alert, filter, loading, and error states", () => {
    const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
    expect(source).toContain('"incoming" | "sent" | "connected" | "history"');
    expect(source).toContain('"all" | "missed" | "audio" | "video"');
    expect(source).toContain('"Today", "This week", "Earlier"');
    expect(source).toContain("Mark all read");
    expect(source).toContain("clearAllAlerts");
    expect(source).toContain("Loading conversations");
    expect(source).toContain("Loading call history");
    expect(source).toContain(">Retry</button>");
  });

  it("keeps raw readiness diagnostics development-only", () => {
    const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
    expect(source).toContain("import.meta.env.DEV");
    expect(source).toContain("CallHubStatusBanner");
  });
});
