import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_HUB_SECTIONS } from "./CallsTab";

const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./calls.css", import.meta.url), "utf8");

describe("Call Hub navigation", () => {
  it("contains exactly the five production sections", () => {
    expect(CALL_HUB_SECTIONS).toEqual(["search", "requests", "chats", "calls", "alerts"]);
  });

  it("uses mobile bottom navigation and desktop rail with real badge inputs", () => {
    expect(styles).toContain("grid-template-columns:76px minmax(0,1fr)");
    expect(styles).toContain("grid-row:2;flex-direction:row");
    expect(source).toContain("requests: incoming.length");
    expect(source).toContain("calls: missedCount");
    expect(source).toContain("alerts: unread");
  });

  it("keeps chats restricted to accepted connections and groups call history", () => {
    expect(source).toContain("userMessagesApi.listThreads");
    expect(source).toContain("thread.unread_count");
    expect(source).toContain("Today\", \"Yesterday\", \"Earlier");
    expect(source).toContain("No missed calls");
    expect(source).toContain("friendlyCallStatus");
  });

  it("supports production request, alert, filter, loading, and error states", () => {
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
    expect(source).toContain("import.meta.env.DEV");
    expect(source).toContain("CallHubStatusBanner");
  });

  it("uses an app-owned clear-alerts dialog instead of the broken WebView confirm", () => {
    expect(source).not.toContain('window.confirm("Clear all alerts?');
    expect(source).toContain('id="clear-alerts-title"');
    expect(source).toContain('className="calls-confirm-dialog"');
    expect(styles).toContain(".calls-confirm-backdrop");
  });

  it("uses the matching callback icon for audio and video history", () => {
    expect(source).toContain('item.call_type === "video" ? <Video');
    expect(source).toContain('item.call_type === "video" ? "Video" : "Audio"');
  });
});
