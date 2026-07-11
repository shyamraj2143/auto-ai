import { Clock3, LoaderCircle, RefreshCw, Search, Settings, ShieldAlert, Users, WifiOff } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { userMessagesApi } from "../userMessages/userMessagesApi";
import { CallSettings } from "./CallSettings";
import { CallUserRow } from "./CallUserRow";
import { useCallSession } from "./hooks/useCallSession";
import { callApi } from "./services/callApi";
import type { CallRecord, CallType, PublicCallUser } from "./types";

type CallsTabProps = {
  refreshRequestId: number;
  onRefreshingChange: (refreshing: boolean) => void;
};

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function CallsTab({ refreshRequestId, onRefreshingChange }: CallsTabProps) {
  const { token, user: currentUser } = useAuth();
  const navigate = useNavigate();
  const { config, error, clearError, refreshRealtime, signalingState, startCall } = useCallSession();
  const [query, setQuery] = useState("");
  const [discoverable, setDiscoverable] = useState<PublicCallUser[]>([]);
  const [online, setOnline] = useState<PublicCallUser[]>([]);
  const [results, setResults] = useState<PublicCallUser[]>([]);
  const [history, setHistory] = useState<CallRecord[]>([]);
  const [view, setView] = useState<"people" | "recent" | "settings">("people");
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const queryRef = useRef(query);
  const refreshPendingRef = useRef(false);
  const searchAbortRef = useRef<AbortController | null>(null);

  const withoutCurrentUser = useCallback(
    (items: PublicCallUser[]) => items.filter((item) => item.id !== currentUser?.id),
    [currentUser?.id],
  );

  const showErrorToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 4500);
  }, []);

  useEffect(() => {
    if (!error) return;
    showErrorToast(error);
    clearError();
  }, [clearError, error, showErrorToast]);

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
      const page = await callApi.searchUsers(token, normalized, 1, 20, controller.signal);
      if (!controller.signal.aborted) setResults(withoutCurrentUser(page.items));
    } catch (searchError) {
      if (!controller.signal.aborted) setMessage(errorText(searchError, "Search failed."));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [token, withoutCurrentUser]);

  const refresh = useCallback(async (notifyOnError = false) => {
    if (!token || refreshPendingRef.current) return;
    refreshPendingRef.current = true;
    onRefreshingChange(true);
    setMessage("");
    const normalized = queryRef.current.trim();
    try {
      const requests = [
        callApi.searchUsers(token, "", 1, 20),
        callApi.onlineUsers(token, 1, 20),
        callApi.history(token, 1, 20),
        refreshRealtime(),
        normalized.length >= 2 ? callApi.searchUsers(token, normalized, 1, 20) : Promise.resolve(null),
      ] as const;
      const [discoverableResult, onlineResult, historyResult, realtimeResult, searchResult] = await Promise.allSettled(requests);
      if (discoverableResult.status === "fulfilled") setDiscoverable(withoutCurrentUser(discoverableResult.value.items));
      if (onlineResult.status === "fulfilled") setOnline(withoutCurrentUser(onlineResult.value.items));
      if (historyResult.status === "fulfilled") setHistory(historyResult.value.items);
      if (searchResult.status === "fulfilled" && searchResult.value) setResults(withoutCurrentUser(searchResult.value.items));
      const failed = [discoverableResult, onlineResult, historyResult, realtimeResult, searchResult]
        .filter((result) => result.status === "rejected");
      if (failed.length && notifyOnError) showErrorToast("Unable to refresh all Calls data. Please try again.");
    } finally {
      refreshPendingRef.current = false;
      onRefreshingChange(false);
    }
  }, [onRefreshingChange, refreshRealtime, showErrorToast, token, withoutCurrentUser]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 25_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (refreshRequestId > 0) void refresh(true);
  }, [refresh, refreshRequestId]);

  useEffect(() => {
    const refreshPresence = () => {
      if (!token) return;
      void Promise.all([callApi.onlineUsers(token, 1, 20), callApi.searchUsers(token, "", 1, 20)])
        .then(([activePage, discoverablePage]) => {
          setOnline(withoutCurrentUser(activePage.items));
          setDiscoverable(withoutCurrentUser(discoverablePage.items));
        })
        .catch(() => undefined);
    };
    window.addEventListener("auto-ai-presence-updated", refreshPresence);
    return () => window.removeEventListener("auto-ai-presence-updated", refreshPresence);
  }, [token, withoutCurrentUser]);

  useEffect(() => {
    queryRef.current = query;
    const normalized = query.trim();
    if (normalized.length < 2) {
      searchAbortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => void runSearch(normalized), 400);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  async function blockUser(user: PublicCallUser) {
    if (!token || !window.confirm(`Block ${user.display_name}? They will no longer be able to find or call you.`)) return;
    await callApi.block(token, user.id);
    setOnline((items) => items.filter((item) => item.id !== user.id));
    setDiscoverable((items) => items.filter((item) => item.id !== user.id));
    setResults((items) => items.filter((item) => item.id !== user.id));
  }

  async function reportUser(user: PublicCallUser) {
    if (!token) return;
    const details = window.prompt(`Report ${user.display_name}. Briefly describe the issue:`);
    if (!details?.trim()) return;
    await callApi.report(token, { user_id: user.id, reason: "other", details: details.trim() });
    setMessage("Report submitted.");
  }

  function placeCall(user: PublicCallUser, type: CallType) {
    if (!callingAvailable) {
      showErrorToast(config?.diagnostic || "Calling service is temporarily unavailable.");
      return;
    }
    void startCall(user, type);
  }

  async function openMessageThread(user: PublicCallUser) {
    if (!token) return;
    setMessage("");
    try {
      const thread = await userMessagesApi.createThread(token, user.id);
      navigate(`/messages/${thread.id}`);
    } catch (chatError) {
      showErrorToast(errorText(chatError, "Unable to open chat."));
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void runSearch(query);
  }

  const featureEnabled = config?.enabled !== false;
  const presenceUnavailable = Boolean(config && !config.realtime_configured);
  const callingAvailable = Boolean(featureEnabled && config?.realtime_configured && signalingState === "connected");
  const row = (item: PublicCallUser) => (
    <CallUserRow
      key={item.id}
      user={item}
      onCall={placeCall}
      onMessage={(selected) => void openMessageThread(selected)}
      onBlock={(selected) => void blockUser(selected)}
      onReport={(selected) => void reportUser(selected)}
      callingAvailable={callingAvailable}
      presenceUnavailable={presenceUnavailable}
    />
  );

  return (
    <div className="calls-tab">
      <form className="calls-search-wrap" onSubmit={submitSearch}>
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users by name or username" aria-label="Search users by name or username" />
        {searching && <LoaderCircle className="animate-spin" size={15} />}
        <button type="submit" disabled={query.trim().length < 2 || searching}>Search</button>
      </form>
      <div className="calls-subtabs">
        <button type="button" className={view === "people" ? "active" : ""} onClick={() => setView("people")}><Users size={14} /> People</button>
        <button type="button" className={view === "recent" ? "active" : ""} onClick={() => setView("recent")}><Clock3 size={14} /> Recent</button>
        <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={14} /> Settings</button>
      </div>
      {presenceUnavailable && <div className="calls-inline-alert"><WifiOff size={14} /> Realtime calling is temporarily unavailable.</div>}
      {!presenceUnavailable && config?.diagnostic && <div className="calls-inline-alert"><ShieldAlert size={14} /> {config.diagnostic}</div>}
      {!presenceUnavailable && featureEnabled && config?.realtime_configured && signalingState !== "connected" && <div className="calls-inline-alert"><WifiOff size={14} /> Reconnecting to calls…</div>}
      {!featureEnabled && <div className="calls-inline-alert"><WifiOff size={14} /> Calls are disabled.</div>}
      {message && <div className="calls-inline-alert"><ShieldAlert size={14} /> {message}</div>}
      {view === "people" && (
        <div className="calls-list">
          {query.trim().length >= 2 ? (
            <>
              <p className="calls-section-label">Search results</p>
              {results.map(row)}
              {!searching && results.length === 0 && <div className="calls-empty">No users found</div>}
            </>
          ) : query.trim().length === 1 ? (
            <div className="calls-empty">Type at least 2 characters to search</div>
          ) : (
            <>
              <p className="calls-section-label">Active Now</p>
              {online.map(row)}
              {online.length === 0 && <div className="calls-empty">No users are currently online</div>}
              <p className="calls-section-label calls-section-label-spaced">All Users</p>
              {discoverable.map(row)}
              {discoverable.length === 0 && <div className="calls-empty">No registered discoverable users found</div>}
            </>
          )}
        </div>
      )}
      {view === "recent" && (
        <div className="calls-list">
          <p className="calls-section-label">Call history</p>
          {history.map((item) => {
            const disabled = item.peer.presence === "busy" || (item.call_type === "video" ? !item.peer.can_video_call : !item.peer.can_audio_call);
            const avatarUrl = resolveApiAssetUrl(item.peer.avatar_url);
            return (
              <div className="call-history-row" key={item.id}>
                <span className="call-user-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : item.peer.display_name.slice(0, 1).toUpperCase()}</span>
                <span><strong>{item.peer.display_name}</strong><small>{item.direction === "incoming" ? "Incoming" : "Outgoing"} {item.call_type} · {item.status}</small></span>
                <button type="button" onClick={() => placeCall(item.peer, item.call_type)} disabled={disabled} title={!callingAvailable ? "Calling service is temporarily unavailable." : "Call again"} aria-label={`Call ${item.peer.display_name}`}><RefreshCw size={15} /></button>
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
