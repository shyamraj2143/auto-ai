import { AlarmClock, FileCheck2, HeartHandshake, MessageCircle, MessagesSquare, MonitorUp, Phone, Settings, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { HubHeader } from "./HubHeader";
import { QuickConnect, type QuickConnectAction } from "./QuickConnect";
import "./actionHub.css";
import "./actionHubStable.css";
import "./sevaHub.css";

const actions = [
  { key: "chat", icon: MessageCircle, title: "AI Chat", description: "Chat with AutoAI, use models, files, voice and images.", path: "/chat", tone: "ai" },
  { key: "seva", icon: FileCheck2, title: "AutoAI Seva", description: "Search a service, fill its form, upload documents and track the application.", path: "/seva", tone: "seva" },
  { key: "calls", icon: Phone, title: "Audio / Video Call", description: "Start calls, view call history and manage contacts.", path: "/call-hub/search", tone: "call" },
  { key: "share", icon: MonitorUp, title: "Screen Sharing", description: "Share your screen or join a secure support session.", path: "/screen-share", tone: "screen" },
  { key: "alarm", icon: AlarmClock, title: "AI Alarm", description: "Create alarms and reminders with native Android support.", path: "/alarms", tone: "alarm" },
  { key: "messages", icon: MessagesSquare, title: "Messages", description: "Open your conversations and message history.", path: "/messages", tone: "relationship" },
  { key: "relationships", icon: HeartHandshake, title: "Relationship Follow-up", description: "Manage people, private notes and follow-up reminders.", path: "/relationships", tone: "relationship" },
  { key: "trust", icon: ShieldCheck, title: "Trust Hub", description: "Review permissions, consent and action controls.", path: "/trust-hub", tone: "trust" },
] as const;

export function ActionHubPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickAction, setQuickAction] = useState<QuickConnectAction>("ai");

  const openQuick = useCallback((action: QuickConnectAction = "ai") => {
    setQuickAction(action);
    setQuickOpen(true);
  }, []);

  if (!user) return null;

  const displayName = typeof user.name === "string" && user.name.trim() ? user.name.trim().split(/\s+/)[0] : "there";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="action-hub-page">
      <HubHeader user={user} unreadNotifications={0} onOpenQuickConnect={() => openQuick("ai")} onLogout={logout} />
      <main className="hub-main">
        <section className="hub-welcome" aria-labelledby="hub-title">
          <div>
            <p>Your AI Control Center</p>
            <h1 id="hub-title">{greeting}, {displayName}</h1>
            <span>Choose a workspace and get things done.</span>
          </div>
          <button type="button" className="hub-welcome-quick" onClick={() => openQuick("ai")}>Quick Connect</button>
        </section>

        <section className="hub-feature-stage" aria-label="AutoAI workspaces">
          {actions.map(({ key, icon: Icon, title, description, path, tone }) => (
            <article key={key} className={`hub-card-position hub-card-${tone}`}>
              <button className="hub-feature-card-stable" type="button" onClick={() => navigate(path)}>
                <span className={`hub-feature-icon hub-feature-icon-${tone}`}><Icon size={25} /></span>
                <span className="hub-feature-copy">
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
                <span className="hub-feature-arrow" aria-hidden="true">→</span>
              </button>
            </article>
          ))}
        </section>

        <section className="hub-dashboard-lower" aria-label="Workspace shortcuts">
          <div className="hub-system-status hub-stable-shortcuts">
            <header><span>Quick access</span><small>All workspaces are available</small></header>
            <div><span>Settings</span><button type="button" onClick={() => navigate("/settings")}><Settings size={15} /> Open</button></div>
            <div><span>Application history</span><button type="button" onClick={() => navigate("/seva/applications")}><FileCheck2 size={15} /> Seva</button></div>
            <div><span>AI conversations</span><button type="button" onClick={() => navigate("/chat")}><MessageCircle size={15} /> Chat</button></div>
          </div>
        </section>
      </main>
      <QuickConnect
        open={quickOpen}
        initialAction={quickAction}
        onClose={() => setQuickOpen(false)}
        onAiCommand={(command) => navigate("/chat", { state: { hubPrompt: command } })}
        onJoinScreen={(code) => navigate(`/screen-share?join=${encodeURIComponent(code)}`)}
        onFindContact={(query, type) => navigate(`/call-hub/search?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`)}
      />
    </div>
  );
}
