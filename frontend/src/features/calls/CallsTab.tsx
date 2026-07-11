import { Bell, Check, Clock3, LoaderCircle, MessageCircle, Phone, Search, Settings, ShieldAlert, UserPlus, Video, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { CallSettings } from "./CallSettings";
import { useCallSession } from "./hooks/useCallSession";
import { callApi } from "./services/callApi";
import { socialApi } from "./services/socialApi";
import type { CallRecord, CallType, PublicCallUser, SocialNotification, SocialProfile, SocialRequest } from "./types";

type CallsTabProps = {
  refreshRequestId: number;
  onRefreshingChange: (refreshing: boolean) => void;
};

type View = "chats" | "calls" | "search" | "requests" | "notifications" | "settings";

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function asCallUser(profile: SocialProfile): PublicCallUser {
  return {
    id: profile.id,
    display_name: profile.display_name,
    username: profile.username,
    avatar_url: profile.avatar_url,
    presence: "offline",
    availability: profile.follow_status === "following" ? "Connected" : "Follow approval required",
    can_audio_call: profile.can_audio_call,
    can_video_call: profile.can_video_call,
  };
}

function Avatar({ profile }: { profile: Pick<SocialProfile, "display_name" | "avatar_url"> }) {
  const avatarUrl = resolveApiAssetUrl(profile.avatar_url);
  return <span className="call-user-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : profile.display_name.slice(0, 1).toUpperCase()}</span>;
}

function FollowBadge({ profile }: { profile: SocialProfile }) {
  const label = profile.follow_status === "following" ? "Following" : profile.follow_status === "pending" ? "Requested" : profile.is_private ? "Private" : "Public";
  return <small>{label}</small>;
}

export function CallsTab({ refreshRequestId, onRefreshingChange }: CallsTabProps) {
  const { token, user: currentUser } = useAuth();
  const navigate = useNavigate();
  const { config, error, clearError, refreshRealtime, signalingState, startCall } = useCallSession();
  const [view, setView] = useState<View>("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SocialProfile[]>([]);
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [selected, setSelected] = useState<SocialProfile | null>(null);
  const [incoming, setIncoming] = useState<SocialRequest[]>([]);
  const [sent, setSent] = useState<SocialRequest[]>([]);
  const [notifications, setNotifications] = useState<SocialNotification[]>([]);
  const [unread, setUnread] = useState(0);
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
      }
    } catch (searchError) {
      if (!controller.signal.aborted) setMessage(errorText(searchError, "Search failed."));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [currentUser?.id, token]);

  const loadRequests = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [incomingPage, sentPage] = await Promise.all([socialApi.incomingRequests(token), socialApi.sentRequests(token)]);
      setIncoming(incomingPage.items);
      setSent(sentPage.items);
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
    if (view === "requests") void loadRequests();
    if (view === "notifications") void loadNotifications();
  }, [loadNotifications, loadRequests, view]);

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
    if (!token) return;
    try {
      const next = profile.follow_status === "following"
        ? await socialApi.unfollow(token, profile.id)
        : profile.follow_status === "pending"
          ? await socialApi.cancelRequest(token, profile.id)
          : await socialApi.follow(token, profile.id);
      updateProfileInLists(next);
      if (next.follow_status === "pending") void loadRequests();
    } catch (actionError) {
      showToast(errorText(actionError, "Unable to update follow state."));
    }
  }

  async function accept(request: SocialRequest) {
    if (!token) return;
    try {
      const profile = await socialApi.acceptRequest(token, request.id);
      setIncoming((items) => items.filter((item) => item.id !== request.id));
      updateProfileInLists(profile);
    } catch (actionError) {
      showToast(errorText(actionError, "Unable to accept request."));
    }
  }

  async function reject(request: SocialRequest) {
    if (!token) return;
    try {
      await socialApi.rejectRequest(token, request.id);
      setIncoming((items) => items.filter((item) => item.id !== request.id));
    } catch (actionError) {
      showToast(errorText(actionError, "Unable to reject request."));
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
      if (item.target_type === "follow_requests") setView("requests");
      if (item.target_type === "call") setView("calls");
      if (item.target_type === "profile" && item.actor) void openProfile(item.actor);
    } catch (notificationError) {
      showToast(errorText(notificationError, "Unable to open notification."));
    }
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
        <button type="button" className={view === "chats" ? "active" : ""} onClick={() => setView("chats")}><MessageCircle size={14} /> Chats</button>
        <button type="button" className={view === "calls" ? "active" : ""} onClick={() => setView("calls")}><Clock3 size={14} /> Calls</button>
        <button type="button" className={view === "search" ? "active" : ""} onClick={() => setView("search")}><Search size={14} /> Search</button>
        <button type="button" className={view === "requests" ? "active" : ""} onClick={() => setView("requests")}><UserPlus size={14} /> Requests</button>
        <button type="button" className={view === "notifications" ? "active" : ""} onClick={() => setView("notifications")}><Bell size={14} /> Alerts{unread > 0 && <i>{unread > 9 ? "9+" : unread}</i>}</button>
        <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={14} /></button>
      </div>
      {!featureEnabled && <div className="calls-inline-alert"><ShieldAlert size={14} /> Calls are disabled.</div>}
      {config?.diagnostic && <div className="calls-inline-alert"><ShieldAlert size={14} /> {config.diagnostic}</div>}
      {message && <div className="calls-inline-alert"><ShieldAlert size={14} /> {message}</div>}

      {view === "chats" && (
        <div className="calls-list social-panel">
          <button type="button" className="social-open-chat" onClick={() => navigate("/messages")}><MessageCircle size={18} /> Open Chats</button>
        </div>
      )}

      {view === "search" && (
        <div className="calls-list social-panel">
          <form className="calls-search-wrap" onSubmit={submitSearch}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or username" aria-label="Search users" />
            {searching && <LoaderCircle className="animate-spin" size={15} />}
            <button type="submit" disabled={query.trim().length < 2 || searching}>Search</button>
          </form>
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
                <div className="social-profile-actions">
                  <button type="button" onClick={() => void applyFollowAction(selected)} disabled={selected.follow_status === "self" || selected.follow_status === "blocked"}>
                    {selected.follow_status === "following" ? "Following" : selected.follow_status === "pending" ? "Requested" : selected.is_private ? "Request" : "Follow"}
                  </button>
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
        <div className="calls-list social-panel">
          {loading && <div className="call-settings-loading"><LoaderCircle className="animate-spin" size={16} /> Loading requests</div>}
          <p className="calls-section-label">Incoming requests</p>
          {incoming.map((request) => (
            <div className="social-request-row" key={request.id}>
              <Avatar profile={request.user} />
              <span><strong>{request.user.display_name}</strong><small>@{request.user.username}</small></span>
              <button type="button" onClick={() => void accept(request)}><Check size={15} /> Accept</button>
              <button type="button" onClick={() => void reject(request)}><X size={15} /> Reject</button>
            </div>
          ))}
          {!incoming.length && !loading && <div className="calls-empty">No incoming requests</div>}
          <p className="calls-section-label calls-section-label-spaced">Sent requests</p>
          {sent.map((request) => (
            <div className="social-request-row" key={request.id}>
              <Avatar profile={request.user} />
              <span><strong>{request.user.display_name}</strong><small>@{request.user.username}</small></span>
              <button type="button" onClick={() => void cancel(request)}><X size={15} /> Cancel</button>
            </div>
          ))}
          {!sent.length && !loading && <div className="calls-empty">No sent requests</div>}
        </div>
      )}

      {view === "notifications" && (
        <div className="calls-list social-panel">
          {notifications.map((item) => (
            <button type="button" className={`social-notification-row ${item.read_at ? "" : "unread"}`} key={item.id} onClick={() => void readNotification(item)}>
              {item.actor ? <Avatar profile={item.actor} /> : <span className="call-user-avatar"><Bell size={16} /></span>}
              <span><strong>{item.title}</strong><small>{new Date(item.created_at).toLocaleString()}</small></span>
            </button>
          ))}
          {!notifications.length && !loading && <div className="calls-empty">No notifications</div>}
        </div>
      )}

      {view === "calls" && (
        <div className="calls-list">
          <p className="calls-section-label">Call history</p>
          {history.map((item) => {
            const avatarUrl = resolveApiAssetUrl(item.peer.avatar_url);
            return (
              <div className="call-history-row" key={item.id}>
                <span className="call-user-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : item.peer.display_name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{item.peer.display_name}</strong><small>{item.direction} {item.call_type} - {item.status}</small></span>
                <button type="button" onClick={() => void startCall(item.peer, item.call_type)} disabled={!callingAvailable}><Phone size={15} /></button>
              </div>
            );
          })}
          {!history.length && <div className="calls-empty">No calls yet</div>}
        </div>
      )}

      {view === "settings" && <div className="calls-list"><CallSettings key={refreshRequestId} /></div>}
      {toast && <div className="calls-toast" role="alert" aria-live="assertive"><ShieldAlert size={15} /> {toast}</div>}
    </div>
  );
}
