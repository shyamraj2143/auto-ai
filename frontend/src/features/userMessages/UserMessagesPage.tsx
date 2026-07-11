import { Archive, ArrowLeft, Check, CheckCheck, FileText, Image, MessageCircle, Mic, MoreVertical, Paperclip, Phone, Pin, Search, Send, Settings, Video, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useCallSession } from "../calls/hooks/useCallSession";
import type { ChatPublicUser, ChatRealtimeEvent, UserMessage, UserThread } from "./types";
import { UserMessageSocket, userMessagesApi } from "./userMessagesApi";
import "./userMessages.css";

const filters = ["all", "unread", "favourites", "archived"] as const;

function eventId() {
  return crypto.randomUUID();
}

function initials(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "A";
}

function timeLabel(value?: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messagePreview(message?: UserMessage | null) {
  if (!message) return "No messages yet";
  if (message.message_type === "image") return "Image";
  if (message.message_type === "file") return message.attachment_name || "File";
  if (message.message_type === "audio") return "Audio message";
  return message.text_content || "Message";
}

function Avatar({ user }: { user: Pick<ChatPublicUser, "display_name" | "avatar_url"> }) {
  const avatar = resolveApiAssetUrl(user.avatar_url);
  return <span className="um-avatar">{avatar ? <img src={avatar} alt="" /> : initials(user.display_name)}</span>;
}

function MessageStatus({ message }: { message: UserMessage }) {
  if (message.status === "read") return <CheckCheck size={14} className="read" />;
  if (message.status === "delivered") return <CheckCheck size={14} />;
  return <Check size={14} />;
}

export function UserMessagesPage() {
  const { token, user } = useAuth();
  const { threadId } = useParams();
  const navigate = useNavigate();
  const callSession = useCallSession();
  const [threads, setThreads] = useState<UserThread[]>([]);
  const [activeThread, setActiveThread] = useState<UserThread | null>(null);
  const [messages, setMessages] = useState<UserMessage[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof filters)[number]>("all");
  const [searchResults, setSearchResults] = useState<ChatPublicUser[]>([]);
  const [openingPeerId, setOpeningPeerId] = useState("");
  const [composer, setComposer] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [typingUsers, setTypingUsers] = useState<Record<string, number>>({});
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const [error, setError] = useState("");
  const socketRef = useRef<UserMessageSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const upsertThread = useCallback((thread: UserThread) => {
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updated_at) - Date.parse(a.updated_at)));
    setActiveThread((current) => current?.id === thread.id ? thread : current);
  }, []);

  const loadThreads = useCallback(async () => {
    if (!token) return;
    const archived = filter === "archived" ? true : filter === "all" || filter === "unread" || filter === "favourites" ? false : undefined;
    const page = await userMessagesApi.listThreads(token, archived);
    setThreads(page.items);
  }, [filter, token]);

  const loadThread = useCallback(async (id: string) => {
    if (!token) return;
    try {
      const [thread, messagePage] = await Promise.all([userMessagesApi.getThread(token, id), userMessagesApi.listMessages(token, id)]);
      setActiveThread(thread);
      upsertThread(thread);
      setMessages(messagePage.items);
      await userMessagesApi.markDelivered(token, id).catch(() => undefined);
      await userMessagesApi.markRead(token, id).catch(() => undefined);
      setThreads((current) => current.map((item) => item.id === id ? { ...item, unread_count: 0 } : item));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to open chat.");
      setActiveThread(null);
      setMessages([]);
    }
  }, [token, upsertThread]);

  const handleRealtime = useCallback((event: ChatRealtimeEvent) => {
    if (event.type === "message.new" || event.type === "message.sent_ack") {
      const message = event.payload.message as UserMessage | undefined;
      if (!message) return;
      setMessages((current) => {
        const filtered = current.filter((item) => item.id !== message.id && item.client_message_id !== message.client_message_id);
        return [...filtered, message].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
      });
      if (event.thread_id && event.thread_id === activeThread?.id && token) {
        void userMessagesApi.markRead(token, event.thread_id);
      } else {
        void loadThreads();
      }
    } else if (event.type === "thread.updated") {
      void loadThreads();
      if (event.thread_id && event.thread_id === activeThread?.id) void loadThread(event.thread_id);
    } else if (event.type === "message.read" || event.type === "message.delivered") {
      if (activeThread?.id) void loadThread(activeThread.id);
    } else if (event.type === "typing.start" && event.thread_id) {
      setTypingUsers((current) => ({ ...current, [event.thread_id!]: Date.now() + 3500 }));
    } else if (event.type === "typing.stop" && event.thread_id) {
      setTypingUsers((current) => ({ ...current, [event.thread_id!]: 0 }));
    } else if (event.type === "error") {
      setError(String(event.payload.detail || "Messaging error"));
    }
  }, [activeThread?.id, loadThread, loadThreads, token]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    if (!token) return;
    socketRef.current?.close();
    const socket = new UserMessageSocket(token, handleRealtime, setSocketState);
    socketRef.current = socket;
    socket.connect();
    return () => socket.close();
  }, [handleRealtime, token]);

  useEffect(() => {
    if (threadId) void loadThread(threadId);
    else {
      setActiveThread(null);
      setMessages([]);
    }
  }, [loadThread, threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, activeThread?.id]);

  useEffect(() => {
    if (!token) return;
    const term = query.trim();
    if (term.length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void userMessagesApi.searchUsers(token, term).then((page) => setSearchResults(page.items)).catch(() => setSearchResults([]));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query, token]);

  const visibleThreads = useMemo(() => {
    const term = query.trim().toLowerCase();
    return threads.filter((thread) => {
      if (filter === "unread" && thread.unread_count < 1) return false;
      if (filter === "favourites" && !thread.pinned) return false;
      if (term && !`${thread.peer.display_name} ${thread.peer.username} ${messagePreview(thread.last_message)}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [filter, query, threads]);

  async function openThread(thread: UserThread) {
    navigate(`/messages/${thread.id}`);
  }

  async function startThread(peer: ChatPublicUser) {
    if (!token) return;
    setOpeningPeerId(peer.id);
    setError("");
    try {
      const thread = await userMessagesApi.createThread(token, peer.id);
      upsertThread(thread);
      setQuery("");
      setSearchResults([]);
      navigate(`/messages/${thread.id}`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Unable to open chat.");
    } finally {
      setOpeningPeerId("");
    }
  }

  function sendTyping(started: boolean) {
    if (!activeThread) return;
    socketRef.current?.send({ type: started ? "typing.start" : "typing.stop", event_id: eventId(), thread_id: activeThread.id, payload: {} });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!token || !activeThread || (!composer.trim() && !attachment)) return;
    const client_message_id = eventId();
    const optimistic: UserMessage = {
      id: `local-${client_message_id}`,
      thread_id: activeThread.id,
      sender_id: user?.id || "",
      client_message_id,
      message_type: attachment ? (attachment.type.startsWith("image/") ? "image" : "file") : "text",
      text_content: composer.trim() || null,
      attachment_name: attachment?.name,
      attachment_size: attachment?.size,
      mime_type: attachment?.type,
      created_at: new Date().toISOString(),
      status: "sent",
    };
    setMessages((current) => [...current, optimistic]);
    setComposer("");
    const file = attachment;
    setAttachment(null);
    sendTyping(false);
    try {
      const sent = file
        ? await userMessagesApi.sendAttachment(token, activeThread.id, file, optimistic.text_content || "", client_message_id)
        : await userMessagesApi.sendMessage(token, activeThread.id, { text_content: optimistic.text_content || "", client_message_id });
      setMessages((current) => current.map((item) => item.client_message_id === client_message_id ? sent : item));
      void loadThreads();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Message failed");
      setMessages((current) => current.filter((item) => item.client_message_id !== client_message_id));
    }
  }

  function pickAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file && file.size <= 20 * 1024 * 1024) setAttachment(file);
    event.target.value = "";
  }

  const typing = activeThread && typingUsers[activeThread.id] > Date.now();

  return (
    <main className="um-page">
      <section className={`um-list ${activeThread ? "has-active" : ""}`}>
        <header className="um-list-head">
          <span><MessageCircle size={20} /><strong>Messages</strong><small>{socketState === "connected" ? "Realtime" : "Connecting"}</small></span>
          <button type="button" onClick={() => navigate("/settings?section=chat")} aria-label="Chat settings"><Settings size={18} /></button>
        </header>
        <label className="um-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search people or chats" /></label>
        <div className="um-filters">
          {filters.map((item) => <button type="button" key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item === "favourites" ? "Favourites" : item[0].toUpperCase() + item.slice(1)}</button>)}
          <button type="button" className="new" onClick={() => setQuery("@")}>+ New Chat</button>
        </div>
        {searchResults.length > 0 && (
          <div className="um-search-results">
            {searchResults.map((peer) => (
              <button type="button" key={peer.id} onClick={() => void startThread(peer)} disabled={openingPeerId === peer.id}>
                <Avatar user={peer} /><span><strong>{peer.display_name}</strong><small>{openingPeerId === peer.id ? "Opening..." : `@${peer.username}`}</small></span>
              </button>
            ))}
          </div>
        )}
        <div className="um-thread-list">
          {visibleThreads.map((thread) => (
            <button type="button" key={thread.id} className={`um-thread ${activeThread?.id === thread.id ? "active" : ""} ${thread.unread_count ? "unread" : ""}`} onClick={() => void openThread(thread)}>
              <Avatar user={thread.peer} />
              <span className="um-thread-copy">
                <strong>{thread.peer.display_name}<small>@{thread.peer.username}</small></strong>
                <em>{messagePreview(thread.last_message)}</em>
              </span>
              <span className="um-thread-meta">
                <time>{timeLabel(thread.last_message?.created_at || thread.updated_at)}</time>
                {thread.unread_count > 0 && <b>{thread.unread_count}</b>}
                <i>{thread.pinned && <Pin size={12} />}{thread.muted && <VolumeX size={12} />}{thread.archived && <Archive size={12} />}</i>
              </span>
            </button>
          ))}
          {!visibleThreads.length && <p className="um-empty">No conversations yet.</p>}
        </div>
      </section>
      <section className={`um-chat ${activeThread ? "open" : ""}`}>
        {activeThread ? (
          <>
            <header className="um-chat-head">
              <button type="button" className="back" onClick={() => navigate("/messages")}><ArrowLeft size={18} /></button>
              <Avatar user={activeThread.peer} />
              <span><strong>{activeThread.peer.display_name}</strong><small>{typing ? "typing..." : `@${activeThread.peer.username} · ${activeThread.peer.availability}`}</small></span>
              <button type="button" onClick={() => void callSession.startCall(activeThread.peer, "audio")} disabled={!activeThread.peer.can_audio_call} aria-label="Audio call"><Phone size={18} /></button>
              <button type="button" onClick={() => void callSession.startCall(activeThread.peer, "video")} disabled={!activeThread.peer.can_video_call} aria-label="Video call"><Video size={19} /></button>
              <button type="button" onClick={() => void userMessagesApi.setPin(token || "", activeThread.id, !activeThread.pinned).then(upsertThread)} aria-label="Pin"><MoreVertical size={18} /></button>
            </header>
            <div className="um-messages">
              {messages.map((message) => {
                const own = message.sender_id === user?.id;
                return (
                  <article key={message.id} className={`um-bubble ${own ? "own" : "peer"}`}>
                    {message.attachment_url && message.message_type === "image" && <img src={resolveApiAssetUrl(message.attachment_url)} alt={message.attachment_name || ""} />}
                    {message.attachment_url && message.message_type !== "image" && <a href={resolveApiAssetUrl(message.attachment_url)} target="_blank" rel="noreferrer"><FileText size={16} />{message.attachment_name || "File"}</a>}
                    {message.text_content && <p>{message.text_content}</p>}
                    <small>{timeLabel(message.created_at)} {own && <MessageStatus message={message} />}</small>
                  </article>
                );
              })}
              <div ref={bottomRef} />
            </div>
            {error && <div className="um-error"><span>{error}</span><button type="button" onClick={() => setError("")}><X size={14} /></button></div>}
            {attachment && <div className="um-attachment-preview">{attachment.type.startsWith("image/") ? <Image size={16} /> : <FileText size={16} />}<span>{attachment.name}</span><button type="button" onClick={() => setAttachment(null)}><X size={14} /></button></div>}
            <form className="um-composer" onSubmit={sendMessage}>
              <label className="um-attach"><Paperclip size={18} /><input type="file" accept="image/*,.pdf,.txt,.doc,.docx,.zip" onChange={pickAttachment} /></label>
              <button type="button" className="um-voice" title="Voice notes are coming soon" aria-label="Voice note placeholder"><Mic size={18} /></button>
              <textarea value={composer} onFocus={() => sendTyping(true)} onBlur={() => sendTyping(false)} onChange={(event) => { setComposer(event.target.value); sendTyping(true); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(event); } }} placeholder="Message" rows={1} />
              <button type="submit" disabled={!composer.trim() && !attachment} aria-label="Send"><Send size={18} /></button>
            </form>
          </>
        ) : (
          <div className="um-no-chat"><MessageCircle size={42} /><strong>Select a chat</strong><span>Search a registered Auto-AI user to start messaging.</span></div>
        )}
      </section>
    </main>
  );
}
