import { apiFetch } from "../../../api/client";
import type {
  BlockedCallUser,
  CallFeatureConfig,
  CallHistoryPage,
  CallRecord,
  CallSettings,
  CallType,
  CallUserPage,
  TurnCredentials,
} from "../types";

export const callApi = {
  config: (token: string) => apiFetch<CallFeatureConfig>("/calls/config", { token, operation: "calls.config" }),
  onlineUsers: (token: string, page = 1, limit = 20, signal?: AbortSignal) =>
    apiFetch<CallUserPage>(`/calls/users/online?page=${page}&limit=${limit}`, { token, signal, operation: "calls.users.online" }),
  searchUsers: (token: string, query: string, page = 1, limit = 20, signal?: AbortSignal) => {
    const params = new URLSearchParams({ query, page: String(page), limit: String(limit) });
    return apiFetch<CallUserPage>(`/calls/users?${params}`, { token, signal, operation: "calls.users.search" });
  },
  settings: (token: string) => apiFetch<CallSettings>("/calls/settings", { token, operation: "calls.settings" }),
  updateSettings: (token: string, payload: Partial<CallSettings>) =>
    apiFetch<CallSettings>("/calls/settings", { method: "PATCH", token, operation: "calls.settings.update", body: JSON.stringify(payload) }),
  registerDevice: (token: string, payload: { device_id: string; platform: "android" | "web"; fcm_token?: string | null; app_version?: string | null; app_version_code?: number; device_name?: string | null }) =>
    apiFetch<{ device_id: string; registered: boolean }>("/calls/devices/register", { method: "POST", token, operation: "calls.devices.register", body: JSON.stringify(payload) }),
  removeDevice: (token: string, deviceId: string) =>
    apiFetch<void>(`/calls/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", token, operation: "calls.devices.remove" }),
  wsTicket: (token: string) => apiFetch<{ ticket: string; expires_in: number }>("/calls/ws-ticket", { method: "POST", token, operation: "calls.wsTicket" }),
  turnCredentials: (token: string) => apiFetch<TurnCredentials>("/calls/turn-credentials", { token, operation: "calls.turn" }),
  initiate: (token: string, calleeUserId: string, callType: CallType, deviceId?: string | null) =>
    apiFetch<CallRecord>("/calls", { method: "POST", token, operation: "calls.initiate", body: JSON.stringify({ callee_user_id: calleeUserId, call_type: callType, caller_device_id: deviceId }) }),
  get: (token: string, callId: string) => apiFetch<CallRecord>(`/calls/${callId}`, { token, operation: "calls.get" }),
  accept: (token: string, callId: string, deviceId?: string | null) =>
    apiFetch<CallRecord>(`/calls/${callId}/accept`, { method: "POST", token, operation: "calls.accept", body: JSON.stringify({ device_id: deviceId }) }),
  reject: (token: string, callId: string) =>
    apiFetch<CallRecord>(`/calls/${callId}/reject`, { method: "POST", token, operation: "calls.reject", body: "{}" }),
  cancel: (token: string, callId: string) =>
    apiFetch<CallRecord>(`/calls/${callId}/cancel`, { method: "POST", token, operation: "calls.cancel", body: "{}" }),
  end: (token: string, callId: string, endReason?: string) =>
    apiFetch<CallRecord>(`/calls/${callId}/end`, { method: "POST", token, operation: "calls.end", body: JSON.stringify({ end_reason: endReason }) }),
  history: (token: string, page = 1, limit = 20) =>
    apiFetch<CallHistoryPage>(`/calls/history?page=${page}&limit=${limit}`, { token, operation: "calls.history" }),
  blocked: (token: string) => apiFetch<BlockedCallUser[]>("/calls/blocked", { token, operation: "calls.blocked" }),
  block: (token: string, userId: string) => apiFetch<void>("/calls/blocked", { method: "POST", token, operation: "calls.block", body: JSON.stringify({ user_id: userId }) }),
  unblock: (token: string, userId: string) => apiFetch<void>(`/calls/blocked/${encodeURIComponent(userId)}`, { method: "DELETE", token, operation: "calls.unblock" }),
  report: (token: string, payload: { user_id: string; reason: string; call_id?: string | null; details?: string }) =>
    apiFetch<void>("/calls/reports", { method: "POST", token, operation: "calls.report", body: JSON.stringify(payload) }),
};
