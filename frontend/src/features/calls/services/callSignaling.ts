import { API_BASE_URL } from "../../../api/client";
import { callApi } from "./callApi";
import type { SignalEnvelope } from "../types";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
const MAX_RECONNECT_ATTEMPTS = 8;

function websocketUrl(ticket: string) {
  const base = new URL(API_BASE_URL, window.location.origin);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = `${base.pathname.replace(/\/$/, "")}/calls/ws`;
  base.search = new URLSearchParams({ ticket }).toString();
  return base.toString();
}

export class CallSignaling {
  private socket: WebSocket | null = null;
  private heartbeatTimer = 0;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private connectionAttempt = 0;
  private token = "";
  private closed = false;
  private seenEvents = new Set<string>();
  private connectedWaiters: Array<(connected: boolean) => void> = [];

  constructor(
    private readonly onEvent: (event: SignalEnvelope) => void,
    private readonly onState: (state: ConnectionState) => void,
  ) {}

  async connect(token: string) {
    this.token = token;
    this.closed = false;
    if (this.socket && (this.socket.readyState === WebSocket.CONNECTING || this.socket.readyState === WebSocket.OPEN)) return;
    const connectionAttempt = ++this.connectionAttempt;
    window.clearTimeout(this.reconnectTimer);
    this.onState("connecting");
    try {
      const { ticket } = await callApi.wsTicket(token);
      if (this.closed || token !== this.token || connectionAttempt !== this.connectionAttempt) return;
      const socket = new WebSocket(websocketUrl(ticket));
      this.socket = socket;
      socket.onopen = () => {
        if (socket !== this.socket) return;
        this.reconnectAttempt = 0;
        this.onState("connected");
        this.connectedWaiters.splice(0).forEach((resolve) => resolve(true));
        this.send("presence.ready", null, { state: document.visibilityState === "hidden" ? "background" : "online" });
        this.startHeartbeat();
      };
      socket.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data.length > 65_536) return;
        try {
          const event = JSON.parse(message.data) as SignalEnvelope;
          if (!event.event_id || this.seenEvents.has(event.event_id)) return;
          this.seenEvents.add(event.event_id);
          if (this.seenEvents.size > 500) this.seenEvents.delete(this.seenEvents.values().next().value as string);
          this.onEvent(event);
        } catch {
          // The server validates all events; malformed responses are ignored client-side.
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
      if (connectionAttempt !== this.connectionAttempt) return;
      this.onState("error");
      if (!this.closed) this.scheduleReconnect();
    }
  }

  async retry(token: string) {
    this.closed = false;
    this.reconnectAttempt = 0;
    window.clearTimeout(this.reconnectTimer);
    await this.connect(token);
  }

  send(type: string, callId: string | null, payload: Record<string, unknown> = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    const event = {
      schema_version: 1,
      event_id: crypto.randomUUID(),
      type,
      call_id: callId,
      timestamp: new Date().toISOString(),
      payload,
    };
    this.socket.send(JSON.stringify(event));
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

  updatePresence(state: "online" | "away" | "background") {
    this.send("presence.status", null, { state });
  }

  close() {
    this.closed = true;
    this.connectionAttempt += 1;
    window.clearTimeout(this.reconnectTimer);
    this.connectedWaiters.splice(0).forEach((resolve) => resolve(false));
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Signed out");
    this.onState("disconnected");
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      this.send("presence.heartbeat", null, { state: document.visibilityState === "hidden" ? "background" : "online" });
    }, 20_000);
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
