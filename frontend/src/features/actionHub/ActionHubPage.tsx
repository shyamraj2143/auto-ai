import { Activity, AlarmClock, CheckCircle2, MessageCircle, MonitorUp, Phone, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useScreenShare } from "../screenShare/useScreenShare";
import { callApi } from "../calls/services/callApi";
import { socialApi } from "../calls/services/socialApi";
import type { CallRecord } from "../calls/types";
import { FeatureCard } from "./FeatureCard";
import { HubHeader } from "./HubHeader";
import { QuickConnect, type QuickConnectAction } from "./QuickConnect";
import { RecentActivity, type HubActivityItem } from "./RecentActivity";
import { callSearchRoute, isActiveScreenShareState } from "./actionHubNavigation";
import "./actionHub.css";
import { useAlarms } from "../alarms/AlarmContext";
import { countdownLabel, formatAlarmDate } from "../alarms/alarmTime";

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function timeLabel(value: string | number) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `Today, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ActionHubPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { token, user, logout } = useAuth();
  const { chats, loadingChats } = useChat();
  const screenShare = useScreenShare();
  const { nextAlarm } = useAlarms();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickAction, setQuickAction] = useState<QuickConnectAction>("ai");
  const activityOnly = location.pathname === "/activity";

  useEffect(() => {
    if (!token) return;
    let active = true;
    setActivityLoading(true);
    setActivityError("");
    void Promise.allSettled([callApi.history(token, 1, 6), socialApi.notifications(token, 1, 1)])
      .then(([historyResult, notificationResult]) => {
        if (!active) return;
        if (historyResult.status === "fulfilled") setCalls(historyResult.value.items);
        else setActivityError("Call activity is temporarily unavailable.");
        if (notificationResult.status === "fulfilled") setUnreadNotifications(notificationResult.value.unread_count);
      })
      .finally(() => { if (active) setActivityLoading(false); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    const openQuickConnect = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuickAction("ai");
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", openQuickConnect);
    return () => window.removeEventListener("keydown", openQuickConnect);
  }, []);

  const openQuick = useCallback((action: QuickConnectAction = "ai") => {
    setQuickAction(action);
    setQuickOpen(true);
  }, []);

  const recentItems = useMemo<HubActivityItem[]>(() => {
    const items: HubActivityItem[] = [];
    const sortedChats = [...chats].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    const chatLimit = activityOnly ? 5 : 1;
    sortedChats.slice(0, chatLimit).forEach((chat) => items.push({
      id: `chat-${chat.id}`,
      tone: "ai",
      label: "Recent AI chat",
      title: chat.title || "Untitled conversation",
      meta: timeLabel(chat.updated_at),
      onOpen: () => navigate(`/chat/${encodeURIComponent(chat.id)}`),
    }));
    if (isActiveScreenShareState(screenShare.uiState) && screenShare.session) {
      const sessionId = screenShare.session.sessionId ?? screenShare.session.session_id ?? "active";
      items.push({
        id: `screen-${sessionId}`,
        tone: "screen",
        label: "Active screen room",
        title: screenShare.role === "sharer" ? "Your screen share" : "Joined screen share",
        meta: `${screenShare.uiState}${screenShare.startedAt ? ` · ${timeLabel(screenShare.startedAt)}` : ""}`,
      });
    }
    const callLimit = activityOnly ? 5 : 1;
    calls.slice(0, callLimit).forEach((call) => items.push({
      id: `call-${call.id}`,
      tone: "call",
      label: `Recent ${call.call_type} call`,
      title: call.peer.display_name,
      meta: `${call.status} · ${timeLabel(call.created_at)}`,
      onOpen: () => navigate("/calls?view=calls"),
    }));
    return activityOnly ? items.slice(0, 10) : items.slice(0, 3);
  }, [activityOnly, calls, chats, navigate, screenShare.role, screenShare.session, screenShare.startedAt, screenShare.uiState]);

  if (!user) return null;
  const firstName = user.name.trim().split(/\s+/)[0] || "there";

  return (
    <div className="action-hub-page">
      <HubHeader
        user={user}
        unreadNotifications={unreadNotifications}
        onOpenQuickConnect={() => openQuick("ai")}
        onLogout={logout}
      />
      <main className="hub-main">
        {activityOnly ? (
          <div className="hub-activity-page">
            <div className="hub-welcome hub-activity-welcome"><p>AutoAI workspace</p><h1>Activity</h1><span>Your real recent chats, calls, and active sharing sessions.</span></div>
            <RecentActivity items={recentItems} loading={loadingChats || activityLoading} error={activityError} expanded />
          </div>
        ) : (
          <>
            <section className="hub-welcome" aria-labelledby="hub-title">
              <p>Your AI Control Center</p>
              <h1 id="hub-title">{greeting()}, {firstName}</h1>
              <span>Choose a workspace and get things done.</span>
            </section>

            <section className="hub-feature-stage" aria-label="Primary AutoAI actions">
              <div className="hub-card-position hub-card-ai">
                <FeatureCard tone="ai" icon={MessageCircle} title="AI Chat" description="Intelligent conversations that get things done." details="Voice · Images · Files · Models" primaryAction={{ label: "Start Chat", onClick: () => navigate("/chat") }} secondaryAction={chats[0] ? { label: "Continue", onClick: () => navigate(`/chat/${encodeURIComponent(chats[0].id)}`) } : undefined} />
              </div>
              <div className="hub-card-position hub-card-screen">
                <FeatureCard tone="screen" icon={MonitorUp} title="Screen Sharing" description="Share, collaborate and solve problems together." details={`${screenShare.canShareScreen ? "Ready to share" : "Join supported"} · ${screenShare.networkQuality === "unknown" ? "secure relay" : `${screenShare.networkQuality} network`}`} primaryAction={{ label: "Share Screen", onClick: () => navigate("/screen-share") }} secondaryAction={{ label: "Join code", onClick: () => openQuick("screen") }} />
              </div>
              <div className="hub-card-position hub-card-call">
                <FeatureCard tone="call" icon={Phone} title="Audio / Video Call" description="Crystal clear calls with contacts and teams." details="Contacts · Recent calls · Alerts" primaryAction={{ label: "Start Call", onClick: () => navigate("/call-hub/search") }} secondaryAction={{ label: "History", onClick: () => navigate("/call-hub/calls") }} />
              </div>
              <div className="hub-card-position hub-card-alarm">
                <FeatureCard tone="alarm" icon={AlarmClock} title="AI Alarm" description="Wake up with a personal reminder in your language." details={nextAlarm ? `${countdownLabel(nextAlarm.scheduled_at)} · ${nextAlarm.title}` : "Calendar · AI voice · Native ringtone"} primaryAction={{ label: "Set Alarm", onClick: () => navigate("/alarms") }} secondaryAction={nextAlarm ? { label: "Manage", onClick: () => navigate("/alarms") } : undefined} />
              </div>
            </section>

            <section className="hub-metric-grid" aria-label="Workspace metrics">
              <article><span><Activity size={16} /> AI conversations</span><strong>{chats.length}</strong><small>Available chat threads</small></article>
              <article><span><MonitorUp size={16} /> Screen sharing</span><strong>{isActiveScreenShareState(screenShare.uiState) ? "Live" : "Ready"}</strong><small>{screenShare.networkQuality === "unknown" ? "Secure relay" : `${screenShare.networkQuality} network`}</small></article>
              <article><span><Phone size={16} /> Call history</span><strong>{calls.length}</strong><small>Recent call records</small></article>
              <article><span><AlarmClock size={16} /> Next alarm</span><strong>{nextAlarm ? new Date(nextAlarm.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Ready"}</strong><small>{nextAlarm ? formatAlarmDate(nextAlarm.scheduled_at) : "No alarm scheduled"}</small></article>
            </section>

            <section className="hub-dashboard-lower">
              <RecentActivity items={recentItems} loading={loadingChats || activityLoading} error={activityError} />
              <aside className="hub-system-status">
                <header><span>Workspace Status</span><small>Live app state</small></header>
                {[
                  ["AI Chat", loadingChats ? "Checking" : "Ready"],
                  ["Calling Service", activityError ? "Unavailable" : activityLoading ? "Checking" : "Connected"],
                  ["Screen Sharing", screenShare.networkQuality === "reconnecting" ? "Reconnecting" : "Operational"],
                  ["Network", navigator.onLine ? "Online" : "Offline"],
                ].map(([label, status]) => (
                  <div key={label}><span><CheckCircle2 size={15} /> {label}</span><small>{status}<i /></small></div>
                ))}
              </aside>
            </section>
            <div className="hub-quick-launch-wrap">
              <button type="button" className="hub-quick-launch" onClick={() => openQuick("ai")}><Zap /> Quick Connect</button>
            </div>
          </>
        )}
      </main>
      <QuickConnect
        open={quickOpen}
        initialAction={quickAction}
        onClose={() => setQuickOpen(false)}
        onAiCommand={(command) => navigate("/chat", { state: { hubPrompt: command } })}
        onJoinScreen={screenShare.joinWithCode}
        onFindContact={(query, type) => navigate(callSearchRoute(query, type))}
      />
    </div>
  );
}
