import { apiFetch, createWebSocketUrl } from "../../api/client";
import type { ChatRealtimeEvent, ChatSettings, ChatUserPage, MessagePage, ThreadPage, UserMessage, UserThread } from "./types";

export const userMessagesApi = {
  listThreads: (token: string, archived?: boolean, signal?: AbortSignal) =>
    apiFetch<ThreadPage>(`/messages${archived === undefined ? "" : `?archived=${archived}`}`, { token, signal, operation: "messages.threads.list" }),
  searchUsers: (token: string, query: string, page = 1, signal?: AbortSignal) =>
    apiFetch<ChatUserPage>(`/messages/search-users?query=${encodeURIComponent(query)}&page=${page}`, { token, signal, operation: "messages.users.search" }),
  createThread: (token: string, peerUserId: string, signal?: AbortSignal) =>
    apiFetch<UserThread>("/messages/threads", { method: "POST", token, signal, operation: "messages.threads.create", body: JSON.stringify({ peer_user_id: peerUserId }) }),
  getThread: (token: string, threadId: string, signal?: AbortSignal) =>
    apiFetch<UserThread>(`/messages/threads/${encodeURIComponent(threadId)}`, { token, signal, operation: "messages.threads.get" }),
  listMessages: (token: string, threadId: string, before?: string, signal?: AbortSignal) =>
    apiFetch<MessagePage>(`/messages/threads/${encodeURIComponent(threadId)}/messages${before ? `?before=${encodeURIComponent(before)}` : ""}`, { token, signal, operation: "messages.list" }),
  sendMessage: (token: string, threadId: string, payload: { text_content: string; client_message_id: string }) =>
    apiFetch<UserMessage>(`/messages/threads/${threadId}/messages`, { method: "POST", token, operation: "messages.send", body: JSON.stringify(payload) }),
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
    this.socket = new WebSocket(wsUrl);
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
