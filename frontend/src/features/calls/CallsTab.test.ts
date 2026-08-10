import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALL_HUB_SECTIONS } from "./CallsTab";

const source = readFileSync(new URL("./CallsTab.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./calls.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("./CallHubShell.tsx", import.meta.url), "utf8");
const provider = readFileSync(new URL("./CallProvider.tsx", import.meta.url), "utf8");
const avatar = readFileSync(new URL("./CallAvatar.tsx", import.meta.url), "utf8");
const workspaceSurfaces = readFileSync(new URL("../../styles/workspaceSurfaces.css", import.meta.url), "utf8");

describe("Call Hub navigation", () => {
  it("contains exactly the five production sections", () => {
    expect(CALL_HUB_SECTIONS).toEqual(["search", "requests", "chats", "calls", "alerts"]);
  });

  it("keeps every Call Hub section in a top navigation bar with real badge inputs", () => {
    expect(shell).toContain('className="calls-tab pulse-connect-shell"');
    expect(shell).toContain("{navigation}{status}");
    expect(shell).not.toContain("{header}");
    expect(source).not.toContain("CallHubHeader");
    expect(styles).toContain(".pulse-connect-nav{z-index:12;display:flex");
    expect(styles).toContain("border-bottom:1px solid");
    expect(styles).not.toContain("grid-row:2;flex-direction:row");
    expect(source).toContain("requests: incoming.length");
    expect(source).toContain("calls: missedCount");
    expect(source).toContain("alerts: unread");
  });

  it("owns vertical scrolling inside the call list without duplicate mobile height", () => {
    expect(styles).toContain(".calls-list { min-height:0; overflow-x:hidden; overflow-y:auto");
    expect(styles).toContain("-webkit-overflow-scrolling:touch");
    expect(styles).toContain(".route-transition-stage:has(>.calls-workspace-page){overflow:hidden}");
    expect(styles).toContain(".calls-workspace-content>.pulse-connect-shell{height:100%;min-height:0;flex:1}");
    expect(styles).toContain(".pulse-connect-content>.calls-list{padding-bottom:18px");
    expect(styles).toContain(".calls-workspace-page{height:100%;min-height:0;padding-bottom:0}");
    expect(workspaceSurfaces).toContain("height: 100vh; height: 100dvh");
    expect(workspaceSurfaces).toContain(".calls-workspace-page { height: 100%; min-height: 0; padding-bottom: 0; }");
  });

  it("uses explicit balanced connection actions without positional button patches", () => {
    expect(source).toContain('className="connected-actions"');
    expect(source).toContain('className="call-hub-action message-action"');
    expect(source).toContain('className="call-hub-action video-action"');
    expect(styles).toContain("grid-template-columns:minmax(0,1fr) 52px");
    expect(styles).toContain(".message-action{width:100%!important");
    expect(styles).not.toContain(".connected-row>button:first-of-type");
    expect(styles).not.toContain(".connections-panel .social-request-row>button:nth-of-type");
  });

  it("keeps sent cancellation full-width on small screens with a guarded loading state", () => {
    expect(source).toContain('className="call-hub-action cancel-request-action"');
    expect(source).toContain('processing ? "Cancelling…" : "Cancel Request"');
    expect(source).toContain("if (!token || pendingRequestId) return;");
    expect(styles).toContain(".sent-request-row>.cancel-request-action{grid-column:1/-1;width:100%");
  });

  it("uses complete keyboard-operable semantics for connection tabs", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('aria-selected={requestView === tab}');
    expect(source).toContain('aria-controls={CONNECTION_PANEL_ID}');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('event.key === "ArrowRight"');
    expect(source).toContain('event.key === "ArrowLeft"');
    expect(source).toContain('tabIndex={requestView === tab ? 0 : -1}');
  });

  it("keeps request actions out of the avatar column with full touch targets", () => {
    expect(source).toContain('className="request-row-actions"');
    expect(styles).toContain(".request-row-actions{display:grid");
    expect(styles).toContain(".request-row-actions button{display:flex;min-width:0;min-height:44px");
    expect(styles).toContain(".connections-panel .request-row-actions{grid-column:1/-1;width:100%}");
  });

  it("keeps all four connection tabs visible on narrow mobile screens", () => {
    expect(styles).toContain(".connection-tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;overflow:visible}");
    expect(styles).toContain(".connection-tabs button{min-width:0;gap:3px;padding:0 2px;font-size:10px}");
  });

  it("does not nest call buttons inside a keyboard-activated chat row", () => {
    expect(source).toContain('className="call-chat-open"');
    expect(source).toContain('className="call-chat-actions"');
    expect(source).not.toContain('className="call-history-row call-chat-row" key={thread.id} role="button"');
    expect(source).not.toContain("event.stopPropagation()");
  });

  it("keeps search controls keyboard-visible with accessible touch targets", () => {
    expect(styles).toContain(".calls-search-wrap:focus-within");
    expect(styles).toContain(".calls-search-wrap>button{min-height:44px");
    expect(styles).toContain(".calls-clear-search{width:44px;min-width:44px");
  });

  it("keeps chats restricted to accepted connections and groups call history", () => {
    expect(source).toContain("userMessagesApi.listThreads");
    expect(source).toContain("thread.unread_count");
    expect(source).toContain('type ChatFilter = "recent" | "unread"');
    expect(source).toContain(">Recent</button>");
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
    expect(source).toContain('onRetry={() => void refresh(true)}');
  });

  it("shows safe readiness diagnostics to users", () => {
    expect(source).toContain("[config?.diagnostic, ...asArray<string>(config?.limitations)]");
    expect(source).not.toContain("import.meta.env.DEV");
    expect(source).toContain("CallHubStatusBanner");
  });

  it("uses friendly request history labels instead of raw backend statuses", () => {
    expect(source).toContain("friendlyRequestStatus(request.status)");
    expect(source).not.toContain("request.actor_label || request.status");
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

  it("keeps call actions clickable while reconnecting and establishes signaling before browser media", () => {
    expect(source).toContain('showToast("Connecting secure call service…")');
    expect(source).toContain("latestConfig = await refreshRealtime()");
    expect(source).not.toContain("disabled={!callingAvailable");
    expect(provider).toContain("await signaling.waitUntilConnected()");
  });

  it("falls back to profile initials when an uploaded avatar URL fails", () => {
    expect(avatar).toContain("onError={() => setFailedUrl(resolvedUrl)}");
    expect(avatar).toContain("call-avatar-fallback");
    expect(styles).toContain(".call-avatar-fallback");
  });
});
