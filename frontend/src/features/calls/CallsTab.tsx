import { Bell, Check, Clock3, LoaderCircle, MessageCircle, Phone, Search, ShieldAlert, Trash2, UserPlus, Video, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiClientError, resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useCallSession } from "./hooks/useCallSession";
import { callApi } from "./services/callApi";
import { socialApi } from "./services/socialApi";
import type { CallRecord, CallType, PublicCallUser, SearchHistoryItem, SocialNotification, SocialProfile, SocialRequest } from "./types";

type CallsTabProps = {
  refreshRequestId: number;
  onRefreshingChange: (refreshing: boolean) => void;
  routeSection?: string;
};

type View = "search" | "requests" | "chats" | "calls" | "alerts";
type RequestView = "incoming" | "sent" | "connected" | "history";
type CallFilter = "all" | "missed" | "audio" | "video";
export const CALL_HUB_SECTIONS = ["search", "requests", "chats", "calls", "alerts"] as const;

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function socialActionError(error: unknown, action: "follow" | "accept") {
  if (error instanceof ApiClientError && error.kind !== "http_error") {
    return action === "follow"
      ? "Follow request could not reach the server. Check your connection and retry."
      : "Accept request could not reach the server. Check your connection and retry.";
  }
  return errorText(error, action === "follow" ? "Unable to update follow status." : "Unable to accept request.");
}

function asCallUser(profile: SocialProfile): PublicCallUser {
  return {
    id: profile.id,
    display_name: profile.display_name,
    username: profile.username,
    avatar_url: profile.avatar_url,
    presence: "offline",
    availability: profile.follow_status === "following" || profile.follow_status === "accepted" ? "Connected" : "Follow approval required",
    can_audio_call: profile.can_audio_call,
    can_video_call: profile.can_video_call,
  };
}

function Avatar({ profile }: { profile: Pick<SocialProfile, "display_name" | "avatar_url"> }) {
  const avatarUrl = resolveApiAssetUrl(profile.avatar_url);
  return <span className="call-user-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : profile.display_name.slice(0, 1).toUpperCase()}</span>;
}

function FollowBadge({ profile }: { profile: SocialProfile }) {
  const label = profile.follow_status === "following" || profile.follow_status === "accepted"
    ? "Connected"
    : profile.follow_status === "pending_received"
      ? "Respond"
      : profile.follow_status === "pending" || profile.follow_status === "pending_sent"
        ? "Requested"
        : profile.is_private ? "Private" : "Public";
  return <small>{label}</small>;
}

function followButtonLabel(profile: SocialProfile) {
  if (profile.follow_status === "following" || profile.follow_status === "accepted") return "Connected";
  if (profile.follow_status === "pending_received") return "Accept";
  if (profile.follow_status === "pending" || profile.follow_status === "pending_sent") return "Requested";
  return "Follow";
}

export function CallsTab({ refreshRequestId, onRefreshingChange, routeSection }: CallsTabProps) {
  const { token, user: currentUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { config, error, clearError, refreshRealtime, signalingState, startCall } = useCallSession();
  const requestedView = searchParams.get("view");
  const requestedCallType = searchParams.get("type") === "video" ? "video" : searchParams.get("type") === "audio" ? "audio" : null;
  const requestedQuery = (searchParams.get("q") || "").slice(0, 80);
  const initialView = (routeSection === "alerts" || routeSection === "chats" || routeSection === "calls" || routeSection === "search" || routeSection === "requests") ? routeSection : (requestedView === "chats" || requestedView === "calls" || requestedView === "search" || requestedView === "requests" || requestedView === "notifications" ? (requestedView === "notifications" ? "alerts" : requestedView) : "search");
  const [view, setView] = useState<View>(initialView);
  const [query, setQuery] = useState(requestedQuery);
  const [results, setResults] = useState<SocialProfile[]>([]);
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [selected, setSelected] = useState<SocialProfile | null>(null);
  const [incoming, setIncoming] = useState<SocialRequest[]>([]);
  const [sent, setSent] = useState<SocialRequest[]>([]);
  const [historyRequests, setHistoryRequests] = useState<SocialRequest[]>([]);
  const [connections, setConnections] = useState<SocialProfile[]>([]);
  const [requestView, setRequestView] = useState<RequestView>("incoming");
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [pendingSocialUserId, setPendingSocialUserId] = useState<string | null>(null);
  const [failedRequestId, setFailedRequestId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<SocialNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [callFilter, setCallFilter] = useState<CallFilter>("all");
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const queryRef = useRef(query);
  const searchAbortRef = useRef<AbortController | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  }, []);

  useEffect(() => {
    if (routeSection === "alerts" || routeSection === "chats" || routeSection === "calls" || routeSection === "search" || routeSection === "requests") setView(routeSection);
    else if (requestedView === "chats" || requestedView === "calls" || requestedView === "search" || requestedView === "requests" || requestedView === "notifications") setView(requestedView === "notifications" ? "alerts" : requestedView);
    if (requestedQuery) setQuery(requestedQuery);
  }, [requestedQuery, requestedView, routeSection]);

  const changeView = useCallback((next: View) => {
    setView(next);
    navigate(`/call-hub/${next}`);
  }, [navigate]);

  useEffect(() => {
    if (!error) return;
    showToast(error);
    clearError();
  }, [clearError, error, showToast]);

  const updateProfileInLists = useCallback((profile: SocialProfile) => {
    setSelected((current) => (current?.id === profile.id ? profile : current));
    setResults((items) => items.map((item) => (item.id === profile.id ? profile : item)));
    setIncoming((items) => items.map((item) => (item.user.id === profile.id ? { ...item, user: profile } : item)));
    setSent((items) => items.map((item) => (item.user.id === profile.id ? { ...item, user: profile } : item)));
  }, []);

  const runSearch = useCallback(async (searchQuery: string) => {
    const normalized = searchQuery.trim();
    searchAbortRef.current?.abort();
    if (!token || normalized.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setMessage("");
    try {
      const page = await socialApi.searchUsers(token, normalized, 1, 20, controller.signal);
      if (!controller.signal.aborted) {
        setResults(page.items.filter((item) => item.id !== currentUser?.id));
        setUnread(page.unread_notifications);
        void socialApi.addSearchHistory(token, normalized).then((item) => setSearchHistory((items) => [item, ...items.filter((entry) => entry.id !== item.id)].slice(0, 20))).catch(() => undefined);
      }
    } catch (searchError) {
      if (!controller.signal.aborted) setMessage(errorText(searchError, "Search failed."));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [currentUser?.id, token]);

  const loadSearchHistory = useCallback(async () => {
    if (!token) return;
    try { setSearchHistory(await socialApi.searchHistory(token)); }
    catch (loadError) { showToast(errorText(loadError, "Unable to load recent searches.")); }
  }, [showToast, token]);

  const loadRequests = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [incomingPage, sentPage, historyPage, connectionsPage] = await Promise.all([
        socialApi.incomingRequests(token), socialApi.sentRequests(token), socialApi.requestHistory(token), socialApi.connections(token)
      ]);
      setIncoming(incomingPage.items);
      setSent(sentPage.items);
      setHistoryRequests(historyPage.items);
      setConnections(connectionsPage.items);
    } catch (loadError) {
      showToast(errorText(loadError, "Unable to load follow requests."));
    } finally {
      setLoading(false);
    }
  }, [showToast, token]);

  const loadNotifications = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const page = await socialApi.notifications(token);
      setNotifications(page.items);
      setUnread(page.unread_count);
    } catch (loadError) {
      showToast(errorText(loadError, "Unable to load notifications."));
    } finally {
      setLoading(false);
    }
  }, [showToast, token]);

  const refresh = useCallback(async (notifyOnError = false) => {
    if (!token) return;
    onRefreshingChange(true);
    setMessage("");
    try {
      const normalized = queryRef.current.trim();
      const requests = [
        callApi.history(token, 1, 20),
        refreshRealtime(),
        normalized.length >= 2 ? socialApi.searchUsers(token, normalized, 1, 20) : Promise.resolve(null),
        socialApi.notifications(token, 1, 1),
      ] as const;
      const [historyResult, realtimeResult, searchResult, notificationResult] = await Promise.allSettled(requests);
      if (historyResult.status === "fulfilled") setHistory(historyResult.value.items);
      if (searchResult.status === "fulfilled" && searchResult.value) setResults(searchResult.value.items.filter((item) => item.id !== currentUser?.id));
      if (notificationResult.status === "fulfilled") setUnread(notificationResult.value.unread_count);
      if (realtimeResult.status === "rejected" && notifyOnError) showToast("Realtime calling is temporarily unavailable.");
    } finally {
      onRefreshingChange(false);
    }
  }, [currentUser?.id, onRefreshingChange, refreshRealtime, showToast, token]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 25_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (refreshRequestId > 0) void refresh(true);
  }, [refresh, refreshRequestId]);

  useEffect(() => {
    queryRef.current = query;
    const normalized = query.trim();
    if (normalized.length < 2) {
      searchAbortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(normalized), 350);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => {
    if (view === "requests" || view === "chats") void loadRequests();
    if (view === "alerts") void loadNotifications();
    if (view === "search" && query.trim().length < 2) void loadSearchHistory();
  }, [loadNotifications, loadRequests, loadSearchHistory, query, view]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  async function openProfile(profile: SocialProfile) {
    if (!token) return;
    setSelected(profile);
    try {
      setSelected(await socialApi.getProfile(token, profile.id));
    } catch (profileError) {
      showToast(errorText(profileError, "Unable to open profile."));
    }
  }

  async function applyFollowAction(profile: SocialProfile) {
    if (!token || pendingSocialUserId) return;
    setPendingSocialUserId(profile.id);
    try {
      if (profile.follow_status === "pending_received" && profile.request_id) {
        const accepted = await socialApi.acceptRequest(token, profile.request_id);
        updateProfileInLists(accepted.connection);
        void loadRequests();
        showToast(accepted.already_accepted ? "Already connected" : "Request accepted");
        return;
      }
      const next = profile.follow_status === "following" || profile.follow_status === "accepted"
        ? await socialApi.unfollow(token, profile.id)
        : profile.follow_status === "pending" || profile.follow_status === "pending_sent"
          ? await socialApi.cancelRequest(token, profile.id)
          : await socialApi.follow(token, profile.id);
      updateProfileInLists(next);
      if (next.follow_status === "pending" || next.follow_status === "pending_sent" || next.follow_status === "pending_received") void loadRequests();
      if (next.follow_status === "pending" || next.follow_status === "pending_sent") showToast("Follow request sent");
      if (next.follow_status === "following" || next.follow_status === "accepted") showToast("Connected");
    } catch (actionError) {
      showToast(socialActionError(actionError, "follow"));
    } finally {
      setPendingSocialUserId(null);
    }
  }

  async function accept(request: SocialRequest) {
    if (!token || pendingRequestId) return;
    setPendingRequestId(request.id);
    setFailedRequestId(null);
    try {
      const result = await socialApi.acceptRequest(token, request.id);
      const profile = result.connection;
      setIncoming((items) => items.filter((item) => item.id !== request.id));
      setConnections((items) => [profile, ...items.filter((item) => item.id !== profile.id)]);
      setHistoryRequests((items) => [result.request, ...items.filter((item) => item.id !== request.id)]);
      updateProfileInLists(profile);
      showToast(result.already_accepted ? "Request was already accepted" : "Request accepted");
    } catch (actionError) {
      if (actionError instanceof ApiClientError && actionError.kind !== "http_error") {
        setFailedRequestId(request.id);
        showToast(socialActionError(actionError, "accept"));
        return;
      }
      try {
        const historyPage = await socialApi.requestHistory(token);
        const accepted = historyPage.items.find((item) => item.id === request.id && item.status === "accepted");
        if (accepted) {
          setIncoming((items) => items.filter((item) => item.id !== request.id));
          setHistoryRequests(historyPage.items);
          updateProfileInLists(accepted.user);
          setConnections((items) => [accepted.user, ...items.filter((item) => item.id !== accepted.user.id)]);
          return;
        }
      } catch {
        // Preserve the original action error when reconciliation is unavailable.
      }
      setFailedRequestId(request.id);
      showToast(errorText(actionError, "Request could not be accepted — Retry"));
    } finally {
      setPendingRequestId(null);
    }
  }

  async function reject(request: SocialRequest) {
    if (!token || pendingRequestId) return;
    setPendingRequestId(request.id);
    try {
      await socialApi.rejectRequest(token, request.id);
      setIncoming((items) => items.filter((item) => item.id !== request.id));
      setHistoryRequests((items) => [{ ...request, status: "rejected", responded_at: new Date().toISOString() }, ...items.filter((item) => item.id !== request.id)]);
      showToast("Request declined");
    } catch (actionError) {
      try {
        const historyPage = await socialApi.requestHistory(token);
        if (historyPage.items.some((item) => item.id === request.id && item.status === "rejected")) {
          setIncoming((items) => items.filter((item) => item.id !== request.id));
          setHistoryRequests(historyPage.items);
          return;
        }
      } catch {
        // Preserve the original action error when reconciliation is unavailable.
      }
      showToast(errorText(actionError, "Unable to reject request."));
    } finally {
      setPendingRequestId(null);
    }
  }

  async function cancel(request: SocialRequest) {
    if (!token) return;
    try {
      const profile = await socialApi.cancelRequest(token, request.user.id);
      setSent((items) => items.filter((item) => item.id !== request.id));
      updateProfileInLists(profile);
    } catch (actionError) {
      showToast(errorText(actionError, "Unable to cancel request."));
    }
  }

  async function openMessage(profile: SocialProfile) {
    if (!token) return;
    try {
      const thread = await socialApi.openConversation(token, profile.id);
      navigate(`/messages/${thread.thread_id}`);
    } catch (chatError) {
      showToast(errorText(chatError, "Follow approval is required before messaging."));
    }
  }

  function placeCall(profile: SocialProfile, type: CallType) {
    if (!callingAvailable) {
      showToast(config?.diagnostic || "Calling service is temporarily unavailable.");
      return;
    }
    if ((type === "audio" && !profile.can_audio_call) || (type === "video" && !profile.can_video_call)) {
      showToast("Follow approval is required before calling this user.");
      return;
    }
    void startCall(asCallUser(profile), type);
  }

  async function block(profile: SocialProfile) {
    if (!token || !window.confirm(`Block ${profile.display_name}?`)) return;
    try {
      await socialApi.block(token, profile.id);
      setSelected(null);
      setResults((items) => items.filter((item) => item.id !== profile.id));
      void loadRequests();
    } catch (blockError) {
      showToast(errorText(blockError, "Unable to block user."));
    }
  }

  async function readNotification(item: SocialNotification) {
    if (!token) return;
    try {
      if (!item.read_at) {
        await socialApi.readNotification(token, item.id);
        setNotifications((items) => items.map((entry) => (entry.id === item.id ? { ...entry, read_at: new Date().toISOString() } : entry)));
        setUnread((count) => Math.max(0, count - 1));
      }
      if (item.target_type === "thread" && item.target_id) navigate(`/messages/${item.target_id}`);
      if (item.target_type === "follow_requests") changeView("requests");
      if (item.target_type === "call") changeView("calls");
      if (item.target_type === "profile" && item.actor) void openProfile(item.actor);
    } catch (notificationError) {
      showToast(errorText(notificationError, "Unable to open notification."));
    }
  }

  async function clearAllSearchHistory() {
    if (!token || !searchHistory.length || !window.confirm("Clear all recent searches?")) return;
    const previous = searchHistory;
    setSearchHistory([]);
    try { await socialApi.clearSearchHistory(token); }
    catch (clearError) { setSearchHistory(previous); showToast(errorText(clearError, "Unable to clear search history.")); }
  }

  async function removeSearchHistory(item: SearchHistoryItem) {
    if (!token) return;
    const previous = searchHistory;
    setSearchHistory((items) => items.filter((entry) => entry.id !== item.id));
    try { await socialApi.deleteSearchHistory(token, item.id); }
    catch (removeError) { setSearchHistory(previous); showToast(errorText(removeError, "Unable to remove search history item.")); }
  }

  async function markAllAlertsRead() {
    if (!token || unread === 0) return;
    try { await socialApi.readAllNotifications(token); setNotifications((items) => items.map((item) => ({ ...item, read_at: item.read_at || new Date().toISOString() }))); setUnread(0); }
    catch (readError) { showToast(errorText(readError, "Unable to mark alerts as read.")); }
  }

  async function clearAllAlerts() {
    if (!token || !notifications.length || !window.confirm("Clear all alerts? Messages, calls and contacts will not be deleted.")) return;
    const previous = notifications;
    const previousUnread = unread;
    setNotifications([]); setUnread(0);
    try { await socialApi.clearNotifications(token); }
    catch (clearError) { setNotifications(previous); setUnread(previousUnread); showToast(errorText(clearError, "Unable to clear alerts.")); }
  }

  async function deleteAlert(item: SocialNotification) {
    if (!token) return;
    try { await socialApi.deleteNotification(token, item.id); setNotifications((items) => items.filter((entry) => entry.id !== item.id)); if (!item.read_at) setUnread((count) => Math.max(0, count - 1)); }
    catch (deleteError) { showToast(errorText(deleteError, "Unable to delete alert.")); }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void runSearch(query);
  }

  const featureEnabled = config?.enabled !== false;
  const callingAvailable = Boolean(featureEnabled && config?.realtime_configured && signalingState === "connected");

  return (
    <div className="calls-tab">
      <div className="calls-subtabs social-tabs">
        <button type="button" className={view === "search" ? "active" : ""} onClick={() => changeView("search")}><Search size={14} /> Search</button>
        <button type="button" className={view === "requests" ? "active" : ""} onClick={() => changeView("requests")}><UserPlus size={14} /> Requests{incoming.length > 0 && <i>{incoming.length > 9 ? "9+" : incoming.length}</i>}</button>
        <button type="button" className={view === "chats" ? "active" : ""} onClick={() => changeView("chats")}><MessageCircle size={14} /> Chats</button>
        <button type="button" className={view === "calls" ? "active" : ""} onClick={() => changeView("calls")}><Clock3 size={14} /> Calls</button>
        <button type="button" className={view === "alerts" ? "active" : ""} onClick={() => changeView("alerts")}><Bell size={14} /> Alerts{unread > 0 && <i>{unread > 9 ? "9+" : unread}</i>}</button>
      </div>
      {!featureEnabled && <div className="calls-inline-alert"><ShieldAlert size={14} /> Calls are disabled.</div>}
      {config?.diagnostic && <div className="calls-inline-alert"><ShieldAlert size={14} /> {config.diagnostic}</div>}
      {config?.limitations?.map((limitation) => <div className="calls-inline-alert" key={limitation}><ShieldAlert size={14} /> {limitation}</div>)}
      {message && <div className="calls-inline-alert"><ShieldAlert size={14} /> {message}</div>}

      {view === "chats" && (
        <div className="calls-list social-panel">
          <p className="calls-section-label">Accepted contacts</p>
          {connections.map((profile) => (
            <div className="call-history-row call-chat-row" key={profile.id} role="button" tabIndex={0} onClick={() => void openMessage(profile)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void openMessage(profile); }}>
              <Avatar profile={profile} />
              <span><strong>{profile.display_name}</strong><small>@{profile.username} · Open conversation</small></span>
              <button type="button" onClick={(event) => { event.stopPropagation(); placeCall(profile, "audio"); }} disabled={!profile.can_audio_call} aria-label={`Voice call ${profile.display_name}`}><Phone size={15} /></button>
              <button type="button" onClick={(event) => { event.stopPropagation(); placeCall(profile, "video"); }} disabled={!profile.can_video_call} aria-label={`Video call ${profile.display_name}`}><Video size={15} /></button>
            </div>
          ))}
          {!connections.length && !loading && <div className="calls-empty">No accepted contacts or conversations yet</div>}
        </div>
      )}

      {view === "search" && (
        <div className="calls-list social-panel">
          {requestedCallType && <p className="calls-section-label">Choose a permitted contact to start a {requestedCallType === "audio" ? "voice" : "video"} call.</p>}
          <form className="calls-search-wrap" onSubmit={submitSearch}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or username" aria-label="Search users" />
            {query && <button type="button" className="calls-clear-search" onClick={() => { setQuery(""); setResults([]); setSelected(null); }} aria-label="Clear search"><X size={14} /></button>}
            {searching && <LoaderCircle className="animate-spin" size={15} />}
            <button type="submit" disabled={query.trim().length < 2 || searching}>Search</button>
          </form>
          {query.trim().length < 2 && (
            <section className="call-hub-history">
              <header><strong>Recent searches</strong><button type="button" onClick={() => void clearAllSearchHistory()} disabled={!searchHistory.length}>Clear history</button></header>
              {searchHistory.map((item) => <div className="call-history-row" key={item.id}>
                {item.selected_user ? <Avatar profile={item.selected_user} /> : <span className="call-user-avatar"><Search size={15} /></span>}
                <button type="button" className="call-history-query" onClick={() => { setQuery(item.query); void runSearch(item.query); }}><strong>{item.selected_user?.display_name || item.query}</strong><small>{item.selected_user ? `@${item.selected_user.username}` : new Date(item.created_at).toLocaleString()}</small></button>
                <button type="button" onClick={() => void removeSearchHistory(item)} aria-label={`Remove ${item.query} from history`}><X size={14} /></button>
              </div>)}
              {!searchHistory.length && <div className="calls-empty">No recent searches</div>}
            </section>
          )}
          <div className="social-search-layout">
            <div className="social-result-list">
              {query.trim().length === 1 && <div className="calls-empty">Type at least 2 characters</div>}
              {query.trim().length >= 2 && results.map((profile) => (
                <button type="button" className="social-user-card" key={profile.id} onClick={() => void openProfile(profile)}>
                  <Avatar profile={profile} />
                  <span><strong>{profile.display_name}</strong><small>@{profile.username}</small></span>
                  <FollowBadge profile={profile} />
                </button>
              ))}
              {!searching && query.trim().length >= 2 && results.length === 0 && <div className="calls-empty">No users found</div>}
            </div>
            {selected && (
              <div className="social-profile-panel">
                <button type="button" className="social-close-profile" onClick={() => setSelected(null)}><X size={15} /></button>
                <Avatar profile={selected} />
                <strong>{selected.display_name}</strong>
                <small>@{selected.username} - {selected.is_private ? "Private" : "Public"}</small>
                <p>{selected.profile_restricted ? "Follow approval is required to view this profile." : selected.bio || "No bio yet."}</p>
                {!selected.can_message && selected.follow_status !== "blocked" && selected.follow_status !== "self" && <p className="social-help-text">Follow request accept hone ke baad message aur call kar sakte hain.</p>}
                <div className="social-profile-actions">
                  <button type="button" onClick={() => void applyFollowAction(selected)} disabled={Boolean(pendingSocialUserId) || selected.follow_status === "self" || selected.follow_status === "blocked"} aria-busy={pendingSocialUserId === selected.id}>
                    {pendingSocialUserId === selected.id && <LoaderCircle className="animate-spin" size={14} />}{followButtonLabel(selected)}
                  </button>
                  {selected.follow_status === "pending_received" && selected.request_id && <button type="button" onClick={() => void reject({ id: selected.request_id || "", status: "pending", requested_at: new Date().toISOString(), user: selected })}><X size={15} /> Reject</button>}
                  <button type="button" onClick={() => void openMessage(selected)} disabled={!selected.can_message}><MessageCircle size={15} /> Message</button>
                  <button type="button" onClick={() => placeCall(selected, "audio")} disabled={!selected.can_audio_call}><Phone size={15} /> Voice</button>
                  <button type="button" onClick={() => placeCall(selected, "video")} disabled={!selected.can_video_call}><Video size={15} /> Video</button>
                  <button type="button" className="danger" onClick={() => void block(selected)}>Block</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {view === "requests" && (
        <div className="calls-list social-panel connections-panel">
          <header className="connections-header">
            <span><strong>Connections</strong><small>Manage requests and conversations</small></span>
            <button type="button" onClick={() => void loadRequests()} disabled={loading} aria-label="Refresh connections"><LoaderCircle className={loading ? "animate-spin" : ""} size={17} /> Refresh</button>
          </header>
          <div className="connection-tabs" role="tablist" aria-label="Connection request categories">
            <button className={requestView === "incoming" ? "active" : ""} onClick={() => setRequestView("incoming")} role="tab">Incoming <i>{incoming.length}</i></button>
            <button className={requestView === "sent" ? "active" : ""} onClick={() => setRequestView("sent")} role="tab">Sent <i>{sent.length}</i></button>
            <button className={requestView === "connected" ? "active" : ""} onClick={() => setRequestView("connected")} role="tab">Connected <i>{connections.length}</i></button>
            <button className={requestView === "history" ? "active" : ""} onClick={() => setRequestView("history")} role="tab">History</button>
          </div>
          {loading && !incoming.length && !sent.length && <div className="connection-skeleton" aria-label="Loading connections"><i /><i /><i /></div>}
          {requestView === "incoming" && incoming.map((request) => {
            const processing = pendingRequestId === request.id;
            return <div className="social-request-row" key={request.id}>
              <Avatar profile={request.user} />
              <span><strong>{request.user.display_name}</strong><small>@{request.user.username} · {new Date(request.requested_at).toLocaleString()}</small></span>
              <button type="button" className="primary" disabled={Boolean(pendingRequestId)} onClick={() => void accept(request)}>
                {processing ? <LoaderCircle className="animate-spin" size={15} /> : failedRequestId === request.id ? <LoaderCircle size={15} /> : <Check size={15} />}
                {processing ? "Accepting…" : failedRequestId === request.id ? "Retry" : "Accept"}
              </button>
              <button type="button" disabled={Boolean(pendingRequestId)} onClick={() => void reject(request)}><X size={15} /> Decline</button>
            </div>;
          })}
          {requestView === "incoming" && !incoming.length && !loading && <div className="calls-empty">No incoming requests</div>}
          {requestView === "sent" && sent.map((request) => <div className="social-request-row" key={request.id}>
            <Avatar profile={request.user} /><span><strong>{request.user.display_name}</strong><small>@{request.user.username} · Sent {new Date(request.requested_at).toLocaleString()}</small></span>
            <button type="button" disabled={Boolean(pendingRequestId)} onClick={() => void cancel(request)}><X size={15} /> Cancel Request</button>
          </div>)}
          {requestView === "sent" && !sent.length && !loading && <div className="calls-empty"><UserPlus size={20} /> No sent requests <button type="button" onClick={() => changeView("search")}>Find People</button></div>}
          {requestView === "connected" && connections.map((profile) => <div className="social-request-row connected-row" key={profile.id}>
            <Avatar profile={profile} /><span><strong>{profile.display_name}</strong><small>@{profile.username}</small></span>
            <button type="button" onClick={() => void openMessage(profile)}><MessageCircle size={15} /> Message</button>
            <button type="button" onClick={() => placeCall(profile, "audio")} disabled={!profile.can_audio_call}><Phone size={15} aria-label="Audio call" /></button>
            <button type="button" onClick={() => placeCall(profile, "video")} disabled={!profile.can_video_call}><Video size={15} aria-label="Video call" /></button>
          </div>)}
          {requestView === "connected" && !connections.length && !loading && <div className="calls-empty">No connections yet</div>}
          {requestView === "history" && historyRequests.map((request) => <div className="social-request-row" key={request.id}>
            <Avatar profile={request.user} /><span><strong>{request.user.display_name}</strong><small>{request.actor_label || request.status} · {request.responded_at ? new Date(request.responded_at).toLocaleString() : new Date(request.requested_at).toLocaleString()}</small></span>
            {request.status === "accepted" && <button type="button" onClick={() => void openMessage(request.user)}><MessageCircle size={15} /> Message</button>}
          </div>)}
          {requestView === "history" && !historyRequests.length && !loading && <div className="calls-empty">No request history</div>}
        </div>
      )}

      {view === "alerts" && (
        <div className="calls-list social-panel">
          <header className="connections-header"><span><strong>Alerts</strong><small>{unread} unread</small></span><span className="call-alert-actions"><button type="button" onClick={() => void markAllAlertsRead()} disabled={!unread}>Mark all read</button><button type="button" onClick={() => void clearAllAlerts()} disabled={!notifications.length}>Clear</button></span></header>
          {notifications.map((item) => (
            <div className={`social-notification-row ${item.read_at ? "" : "unread"}`} key={item.id}>
              <button type="button" className="social-notification-open" onClick={() => void readNotification(item)}>
              {item.actor ? <Avatar profile={item.actor} /> : <span className="call-user-avatar"><Bell size={16} /></span>}
              <span><strong>{item.title}</strong><small>{new Date(item.created_at).toLocaleString()}</small></span>
              </button>
              <button type="button" onClick={() => void deleteAlert(item)} aria-label={`Delete alert: ${item.title}`}><Trash2 size={14} /></button>
            </div>
          ))}
          {!notifications.length && !loading && <div className="calls-empty">No alerts</div>}
        </div>
      )}

      {view === "calls" && (
        <div className="calls-list">
          <p className="calls-section-label">Call history</p>
          <div className="call-log-filters" role="tablist" aria-label="Call history filters">{(["all", "missed", "audio", "video"] as CallFilter[]).map((filter) => <button type="button" role="tab" aria-selected={callFilter === filter} className={callFilter === filter ? "active" : ""} onClick={() => setCallFilter(filter)} key={filter}>{filter === "audio" ? "Voice" : filter.charAt(0).toUpperCase() + filter.slice(1)}</button>)}</div>
          {history.filter((item) => callFilter === "all" || (callFilter === "missed" ? item.status === "missed" : item.call_type === callFilter)).map((item) => {
            const avatarUrl = resolveApiAssetUrl(item.peer.avatar_url);
            return (
              <div className="call-history-row" key={item.id}>
                <span className="call-user-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : item.peer.display_name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{item.peer.display_name}</strong><small>{item.direction} {item.call_type} - {item.status}</small></span>
                <button type="button" onClick={() => void startCall(item.peer, item.call_type)} disabled={!callingAvailable}><Phone size={15} /></button>
              </div>
            );
          })}
          {!history.filter((item) => callFilter === "all" || (callFilter === "missed" ? item.status === "missed" : item.call_type === callFilter)).length && <div className="calls-empty">No matching calls</div>}
        </div>
      )}

      {toast && <div className="calls-toast" role="alert" aria-live="assertive"><ShieldAlert size={15} /> {toast}</div>}
    </div>
  );
}
