import { MoreHorizontal, RefreshCw } from "lucide-react";

const subtitles = { search: "Find people and build trusted connections", requests: "Manage your connection circle", chats: "Conversations with accepted contacts", calls: "Your secure calling timeline", alerts: "Activity that needs your attention" } as const;

export function CallHubHeader({ view, ready, refreshing, onRefresh, onSettings }: { view: keyof typeof subtitles; ready: "ready" | "limited" | "unavailable"; refreshing: boolean; onRefresh: () => void; onSettings: () => void }) {
  const readinessLabel = ready === "ready" ? "Ready" : ready === "limited" ? "Limited" : "Unavailable";
  return <header className="pulse-connect-header"><span><strong>Pulse Connect</strong><small>{subtitles[view]}</small></span><span className="pulse-header-actions"><i className={`availability-dot ${ready}`} aria-label={`Call availability ${readinessLabel}`} /><b className={`readiness-pill ${ready}`}>{readinessLabel}</b><button type="button" onClick={onRefresh} disabled={refreshing} aria-label="Refresh Pulse Connect"><RefreshCw className={refreshing ? "animate-spin" : ""} size={17} /></button><button type="button" onClick={onSettings} aria-label="Pulse Connect settings"><MoreHorizontal size={18} /></button></span></header>;
}
