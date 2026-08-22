import { apiFetch, createWebSocketUrl } from "../../api/client";
import type { ChatRealtimeEvent, ChatSettings, ChatUserPage, MessagePage, ThreadPage, UserMessage, UserThread } from "./types";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = "autoai:messages-cache:v2:";
const OUTBOX_PREFIX = "autoai:messages-outbox:v1:";

type CachedValue<T> = { saved_at: number; value: T };
type QueuedTextMessage = { threadId: string; payload: { text_content: string; client_message_id: string }; queued_at: number };

function stableTokenKey(token: string) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(token: string, suffix: string) {
  return `${CACHE_PREFIX}${stableTokenKey(token)}:${suffix}`;
}

function outboxKey(token: string) {
  return `${OUTBOX_PREFIX}${stableTokenKey(token)}`;
}

function cacheRead<T>(token: string, suffix: string): T | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(token, suffix));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedValue<T>;
    if (!entry?.saved_at || Date.now() - entry.saved_at > CACHE_TTL_MS) return null;
    return entry.value ?? null;
  } catch {
    return null;
  }
}

function cacheWrite<T>(token: string, suffix: string, value: T) {
  try {
    window.localStorage.setItem(cacheKey(token, suffix), JSON.stringify({ saved_at: Date.now(), value } satisfies CachedValue<T>));
  } catch {
    // Storage is best effort; the live API remains the source of truth online.
  }
}

function queuedMessages(token: string): QueuedTextMessage[] {
  try {
    const raw = window.localStorage.getItem(outboxKey(token));
    if (!raw) return [];
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveQueuedMessages(token: string, queue: QueuedTextMessage[]) {
  try {
    if (queue.length) window.localStorage.setItem(outboxKey(token), JSON.stringify(queue.slice(-100)));
    else window.localStorage.removeItem(outboxKey(token));
  } catch {
    return;
  }
}

function localUserId(token: string) {
  try {
    const payload = token.split(".")[1];
    if (payload) {
      const json = JSON.parse(decodeURIComponent(escape(window.atob(payload.replace(/-/g, "+").replace(/_/g, "/")))));
      if (typeof json.sub === "string") return json.sub;
    }
  } catch {
    // Fall through to a device-local sender id.
  }
  return `offline-${stableTokenKey(token)}`;
}

function makeOfflineMessage(token: string, threadId: string, payload: { text_content: string; client_message_id: string }): UserMessage {
  return {
    id: `offline-${payload.client_message_id}`,
    thread_id: threadId,
    sender_id: localUserId(token),
    client_message_id: payload.client_message_id,
    message_type: "text",
    text_content: payload.text_content,
    created_at: new Date().toISOString(),
    status: "sending",
  };
}

function cacheThreadMessage(token: string, threadId: string, message: UserMessage) {
  const current = cacheRead<MessagePage>(token, `messages:${threadId}`);
  if (!current) return;
  const items = [...current.items.filter((item) => item.id !== message.id && item.client_message_id !== message.client_message_id), message]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  cacheWrite(token, `messages:${threadId}`, { ...current, items });
}

function cacheThreadPreview(token: string, threadId: string, message: UserMessage) {
  const current = cacheRead<ThreadPage>(token, "threads:all");
  if (!current) return;
  const items = current.items.map((thread) => thread.id === threadId
    ? { ...thread, last_message: message, updated_at: message.created_at }
    : thread);
  cacheWrite(token, "threads:all", { ...current, items });
}

async function flushOutbox(token: string) {
  if (!navigator.onLine) return;
  const queue = queuedMessages(token);
  if (!queue.length) return;
  const remaining: QueuedTextMessage[] = [];
  for (const item of queue) {
    try {
      await apiFetch<UserMessage>(`/messages/threads/${encodeURIComponent(item.threadId)}/messages`, {
        method: "POST",
        token,
        operation: "messages.send.offline_sync",
        body: JSON.stringify(item.payload),
      });
    } catch {
      remaining.push(item);
    }
  }
  saveQueuedMessages(token, remaining);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    // All active API callers own their token; the queue is flushed lazily on the next send/load.
  });
}

export const userMessagesApi = {
  listThreads: async (token: string, archived?: boolean, signal?: AbortSignal) => {
    try {
      const page = await apiFetch<ThreadPage>(`/messages${archived === undefined ? "" : `?archived=${archived}`}`, { token, signal, operation: "messages.threads.list" });
      cacheWrite(token, archived ? "threads:archived" : "threads:all", page);
      return page;
    } catch (error) {
      const cached = cacheRead<ThreadPage>(token, archived ? "threads:archived" : "threads:all");
      if (cached) return cached;
      throw error;
    }
  },
  searchUsers: async (token: string, query: string, page = 1, signal?: AbortSignal) => {
    const suffix = `users:${page}:${query.trim().toLowerCase()}`;
    try {
      const result = await apiFetch<ChatUserPage>(`/messages/search-users?query=${encodeURIComponent(query)}&page=${page}`, { token, signal, operation: "messages.users.search" });
      cacheWrite(token, suffix, result);
      return result;
    } catch (error) {
      const cached = cacheRead<ChatUserPage>(token, suffix);
      if (cached) return cached;
      throw error;
    }
  },
  createThread: (token: string, peerUserId: string, signal?: AbortSignal) =>
    apiFetch<UserThread>("/messages/threads", { method: "POST", token, signal, operation: "messages.threads.create", body: JSON.stringify({ peer_user_id: peerUserId }) }),
  getThread: async (token: string, threadId: string, signal?: AbortSignal) => {
    try {
      const thread = await apiFetch<UserThread>(`/messages/threads/${encodeURIComponent(threadId)}`, { token, signal, operation: "messages.threads.get" });
      cacheWrite(token, `thread:${threadId}`, thread);
      return thread;
    } catch (error) {
      const cached = cacheRead<UserThread>(token, `thread:${threadId}`);
      if (cached) return cached;
      throw error;
    }
  },
  listMessages: async (token: string, threadId: string, before?: string, signal?: AbortSignal) => {
    const suffix = `messages:${threadId}${before ? `:${before}` : ":latest"}`;
    try {
      const page = await apiFetch<MessagePage>(`/messages/threads/${encodeURIComponent(threadId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`, { token, signal, operation: "messages.list" });
      if (!before) cacheWrite(token, suffix, page);
      return page;
    } catch (error) {
      if (!before) {
        const cached = cacheRead<MessagePage>(token, suffix);
        if (cached) return cached;
      }
      throw error;
    }
  },
  sendMessage: async (token: string, threadId: string, payload: { text_content: string; client_message_id: string }) => {
    try {
      await flushOutbox(token);
      const message = await apiFetch<UserMessage>(`/messages/threads/${encodeURIComponent(threadId)}/messages`, { method: "POST", token, operation: "messages.send", body: JSON.stringify(payload) });
      cacheThreadMessage(token, threadId, message);
      cacheThreadPreview(token, threadId, message);
      return message;
    } catch (error) {
      if (navigator.onLine) throw error;
      const message = makeOfflineMessage(token, threadId, payload);
      const queue = queuedMessages(token).filter((item) => item.payload.client_message_id !== payload.client_message_id);
      queue.push({ threadId, payload, queued_at: Date.now() });
      saveQueuedMessages(token, queue);
      cacheThreadMessage(token, threadId, message);
      cacheThreadPreview(token, threadId, message);
      return message;
    }
  },
  deleteMessage: (token: string, threadId: string, messageId: string) =>
    apiFetch<void>(`/messages/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`, { method: "DELETE", token, operation: "messages.delete" }),
  sendAttachment: (token: string, threadId: string, file: File, textContent: string, clientMessageId: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("client_message_id", clientMessageId);
    if (textContent.trim()) formData.append("text_content", textContent.trim());
    return apiFetch<UserMessage>(`/messages/threads/${threadId}/attachments`, { method: "POST", token, operation: "messages.attachments.send", body: formData });
  },
  markRead: (token: string, threadId: string) =>
    apiFetch<void>(`/messages/threads/${threadId}/read`, { method: "POST", token, operation: "messages.read" }),
  markDelivered: (token: string, threadId: string) =>
    apiFetch<void>(`/messages/threads/${threadId}/delivered`, { method: "POST", token, operation: "messages.delivered" }),
  setArchive: (token: string, threadId: string, enabled: boolean) =>
    apiFetch<UserThread>(`/messages/threads/${threadId}/archive`, { method: "POST", token, operation: "messages.archive", body: JSON.stringify({ enabled }) }),
  setPin: (token: string, threadId: string, enabled: boolean) =>
    apiFetch<UserThread>(`/messages/threads/${threadId}/pin`, { method: "POST", token, operation: "messages.pin", body: JSON.stringify({ enabled }) }),
  setMute: (token: string, threadId: string, enabled: boolean) =>
    apiFetch<UserThread>(`/messages/threads/${threadId}/mute`, { method: "POST", token, operation: "messages.mute", body: JSON.stringify({ enabled }) }),
  settings: (token: string) => apiFetch<ChatSettings>("/messages/settings", { token, operation: "messages.settings" }),
  updateSettings: (token: string, payload: Partial<ChatSettings>) =>
    apiFetch<ChatSettings>("/messages/settings", { method: "PATCH", token, operation: "messages.settings.update", body: JSON.stringify(payload) }),
};

export class UserMessageSocket {
  private socket: WebSocket | null = null;
  private queue: ChatRealtimeEvent[] = [];
  private closed = false;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private readonly maxReconnectAttempts = 8;

  constructor(private token: string, private onEvent: (event: ChatRealtimeEvent) => void, private onState: (state: "connecting" | "connected" | "disconnected") => void) {}

  connect() {
    this.closed = false;
    this.onState("connecting");
    const wsUrl = createWebSocketUrl("/api/v1/messages/ws", { token: this.token });
    try {
      this.socket = new WebSocket(wsUrl);
    } catch {
      this.onState("disconnected");
      return;
    }
    this.socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.onState("connected");
      const pending = this.queue.splice(0);
      pending.forEach((event) => this.send(event));
    };
    this.socket.onmessage = (message) => {
      try {
        this.onEvent(JSON.parse(message.data) as ChatRealtimeEvent);
      } catch {
        return;
      }
    };
    this.socket.onclose = () => {
      this.onState("disconnected");
      if (!this.closed) {
        if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
        const delay = Math.min(15_000, 750 * 2 ** Math.min(this.reconnectAttempt, 5));
        this.reconnectAttempt += 1;
        this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
      }
    };
  }

  send(event: ChatRealtimeEvent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(event));
    } else {
      this.queue.push(event);
    }
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }
}
