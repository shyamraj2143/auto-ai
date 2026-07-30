import { Bell, Clock3, MessageCircle, Search, UserPlus } from "lucide-react";

export type CallHubView = "search" | "requests" | "chats" | "calls" | "alerts";
const items = [
  ["search", "Search", Search], ["requests", "Requests", UserPlus], ["chats", "Chats", MessageCircle],
  ["calls", "Calls", Clock3], ["alerts", "Alerts", Bell],
] as const;

export function CallHubNavigation({ active, counts, onChange }: { active: CallHubView; counts: Partial<Record<CallHubView, number>>; onChange: (view: CallHubView) => void }) {
  return <nav className="pulse-connect-nav" aria-label="Pulse Connect sections">{items.map(([view, label, Icon]) => {
    const count = counts[view] || 0;
    return <button key={view} type="button" className={active === view ? "active" : ""} aria-current={active === view ? "page" : undefined} onClick={() => onChange(view)}>
      <Icon size={19} /><span>{label}</span>{count > 0 && <i aria-label={`${count} ${label.toLowerCase()}`}>{count > 99 ? "99+" : count}</i>}
    </button>;
  })}</nav>;
}
