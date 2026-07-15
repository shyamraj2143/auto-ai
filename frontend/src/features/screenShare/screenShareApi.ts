import { apiFetch, createWebSocketUrl } from "../../api/client";
import type { ScreenShareSession, ScreenShareSignal } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
const MAX_RECONNECT_ATTEMPTS = 8;

function websocketUrl(ticket: string) {
  return createWebSocketUrl("/api/v1/screen-share/ws", { ticket });
}

export const screenShareApi = {
  createSession: (token: string, payload: { viewer_user_id?: string | null; invite_link?: boolean; expires_minutes?: number }) =>
    apiFetch<ScreenShareSession>("/screen-share/session", {
      method: "POST",
      token,
      operation: "screenShare.session.create",
      body: JSON.stringify(payload),
    }),
  getSession: (token: string, sessionId: string, invite?: string | null) =>
    apiFetch<ScreenShareSession>(
      `/screen-share/session/${encodeURIComponent(sessionId)}${invite ? `?invite=${encodeURIComponent(invite)}` : ""}`,
      { token, operation: "screenShare.session.get" },
    ),
  endSession: (token: string, sessionId: string) =>
    apiFetch<ScreenShareSession>(`/screen-share/session/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      token,
      operation: "screenShare.session.end",
      body: "{}",
    }),
  wsTicket: (token: string) =>
    apiFetch<{ ticket: string; expires_in: number }>("/screen-share/ws-ticket", {
      method: "POST",
      token,
      operation: "screenShare.wsTicket",
    }),
  turnCredentials: (token: string) => apiFetch<{ iceServers?: RTCIceServer[]; ice_servers?: RTCIceServer[] }>("/calls/turn-credentials", { token, operation: "screenShare.turn" }),
};

export class ScreenShareSignaling {
  private socket: WebSocket | null = null;
  private heartbeatTimer = 0;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private token = "";
  private closed = false;
  private seenEvents = new Set<string>();
  private connectedWaiters: Array<(connected: boolean) => void> = [];

  constructor(
    private readonly onEvent: (event: ScreenShareSignal) => void,
    private readonly onState: (state: ConnectionState) => void,
  ) {}

  async connect(token: string) {
    this.token = token;
    this.closed = false;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;
    window.clearTimeout(this.reconnectTimer);
    this.onState("connecting");
    try {
      const { ticket } = await screenShareApi.wsTicket(token);
      if (this.closed || token !== this.token) return;
      const socket = new WebSocket(websocketUrl(ticket));
      this.socket = socket;
      socket.onopen = () => {
        if (socket !== this.socket) return;
        this.reconnectAttempt = 0;
        this.onState("connected");
        this.connectedWaiters.splice(0).forEach((resolve) => resolve(true));
        this.startHeartbeat();
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data.length > 65_536) return;
        try {
          const event = JSON.parse(message.data) as ScreenShareSignal;
          if (!event.event_id || this.seenEvents.has(event.event_id)) return;
          this.seenEvents.add(event.event_id);
          if (this.seenEvents.size > 500) this.seenEvents.delete(this.seenEvents.values().next().value as string);
          this.onEvent(event);
        } catch {
          return;
        }
      };
      socket.onerror = () => this.onState("error");
      socket.onclose = () => {
        if (socket !== this.socket) return;
        this.socket = null;
        this.stopHeartbeat();
        this.onState("disconnected");
        if (!this.closed) this.scheduleReconnect();
      };
    } catch {
      this.onState("error");
      if (!this.closed) this.scheduleReconnect();
    }
  }

  send(type: string, sessionId: string | null, payload: Record<string, unknown> = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({
      schema_version: 1,
      event_id: crypto.randomUUID(),
      type,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      payload,
    }));
    return true;
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async waitUntilConnected(timeoutMs = 7000) {
    if (this.isConnected()) return true;
    return new Promise<boolean>((resolve) => {
      const done = (value: boolean) => {
        window.clearTimeout(timer);
        const index = this.connectedWaiters.indexOf(waiter);
        if (index >= 0) this.connectedWaiters.splice(index, 1);
        resolve(value);
      };
      const waiter = (connected: boolean) => done(connected);
      const timer = window.setTimeout(() => done(false), timeoutMs);
      this.connectedWaiters.push(waiter);
    });
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    this.connectedWaiters.splice(0).forEach((resolve) => resolve(false));
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Closed");
    this.onState("disconnected");
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.send("ping", null), 20_000);
  }

  private stopHeartbeat() {
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = 0;
  }

  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      this.closed = true;
      this.onState("error");
      return;
    }
    const delay = Math.min(15_000, 750 * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => void this.connect(this.token), delay);
  }
}
