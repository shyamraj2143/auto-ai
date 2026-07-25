import { apiFetch } from "../../../api/client";
import type { ConnectionAcceptResult, SocialNotificationPage, SocialProfile, SocialRequestPage, SocialUserPage } from "../types";

export const socialApi = {
  searchUsers: (token: string, query: string, page = 1, limit = 20, signal?: AbortSignal) => {
    const params = new URLSearchParams({ query, page: String(page), limit: String(limit) });
    return apiFetch<SocialUserPage>(`/social/users?${params}`, { token, signal, operation: "social.users.search" });
  },
  getProfile: (token: string, userId: string, signal?: AbortSignal) =>
    apiFetch<SocialProfile>(`/social/users/${encodeURIComponent(userId)}`, { token, signal, operation: "social.profile" }),
  follow: (token: string, userId: string) =>
    apiFetch<SocialProfile>(`/social/users/${encodeURIComponent(userId)}/follow`, { method: "POST", token, operation: "social.follow" }),
  cancelRequest: (token: string, userId: string) =>
    apiFetch<SocialProfile>(`/social/users/${encodeURIComponent(userId)}/cancel-request`, { method: "POST", token, operation: "social.request.cancel" }),
  unfollow: (token: string, userId: string) =>
    apiFetch<SocialProfile>(`/social/users/${encodeURIComponent(userId)}/follow`, { method: "DELETE", token, operation: "social.unfollow" }),
  incomingRequests: (token: string, page = 1, limit = 30) =>
    apiFetch<SocialRequestPage>(`/social/requests/incoming?page=${page}&limit=${limit}`, { token, operation: "social.requests.incoming" }),
  sentRequests: (token: string, page = 1, limit = 30) =>
    apiFetch<SocialRequestPage>(`/social/requests/sent?page=${page}&limit=${limit}`, { token, operation: "social.requests.sent" }),
  requestHistory: (token: string, page = 1, limit = 30) =>
    apiFetch<SocialRequestPage>(`/social/requests/history?page=${page}&limit=${limit}`, { token, operation: "social.requests.history" }),
  connections: (token: string, query = "", page = 1, limit = 30, signal?: AbortSignal) => {
    const params = new URLSearchParams({ query, page: String(page), limit: String(limit) });
    return apiFetch<SocialUserPage>(`/social/connections?${params}`, { token, signal, operation: "social.connections" });
  },
  acceptRequest: (token: string, requestId: string) =>
    apiFetch<ConnectionAcceptResult>(`/social/requests/${encodeURIComponent(requestId)}/accept`, { method: "POST", token, operation: "social.requests.accept" }),
  rejectRequest: (token: string, requestId: string) =>
    apiFetch<void>(`/social/requests/${encodeURIComponent(requestId)}/reject`, { method: "POST", token, operation: "social.requests.reject" }),
  block: (token: string, userId: string) =>
    apiFetch<void>(`/social/users/${encodeURIComponent(userId)}/block`, { method: "POST", token, operation: "social.block" }),
  unblock: (token: string, userId: string) =>
    apiFetch<void>(`/social/users/${encodeURIComponent(userId)}/block`, { method: "DELETE", token, operation: "social.unblock" }),
  notifications: (token: string, page = 1, limit = 30) =>
    apiFetch<SocialNotificationPage>(`/social/notifications?page=${page}&limit=${limit}`, { token, operation: "social.notifications" }),
  readNotification: (token: string, notificationId: string) =>
    apiFetch<void>(`/social/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", token, operation: "social.notifications.read" }),
  openConversation: (token: string, userId: string) =>
    apiFetch<{ thread_id: string }>(`/social/users/${encodeURIComponent(userId)}/conversation`, { method: "POST", token, operation: "social.conversation" }),
};
