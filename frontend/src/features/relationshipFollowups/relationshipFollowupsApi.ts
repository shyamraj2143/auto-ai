import { apiFetch } from "../../api/client";
import type { ContactFormPayload, FollowupPreferences, FollowupSummary, RelationshipContact, RelationshipContactDetail, RelationshipContactPage } from "./types";

function requestId() {
  return crypto.randomUUID();
}

export const relationshipFollowupsApi = {
  list(token: string, filters: { query?: string; relationshipType?: string; priority?: string; bucket?: string; sort?: string; page?: number; limit?: number }, signal?: AbortSignal) {
    const params = new URLSearchParams({ page: String(filters.page ?? 1), limit: String(filters.limit ?? 30), sort: filters.sort ?? "due_asc" });
    if (filters.query) params.set("query", filters.query);
    if (filters.relationshipType) params.set("relationship_type", filters.relationshipType);
    if (filters.priority) params.set("priority", filters.priority);
    if (filters.bucket) params.set("bucket", filters.bucket);
    return apiFetch<RelationshipContactPage>(`/relationship-followups?${params}`, { token, signal, operation: "relationships.list" });
  },
  summary: (token: string, signal?: AbortSignal) => apiFetch<FollowupSummary>("/relationship-followups/summary", { token, signal, operation: "relationships.summary" }),
  detail: (token: string, id: string, signal?: AbortSignal) => apiFetch<RelationshipContactDetail>(`/relationship-followups/${encodeURIComponent(id)}`, { token, signal, operation: "relationships.detail" }),
  create: (token: string, payload: ContactFormPayload) => apiFetch<RelationshipContact>("/relationship-followups", { method: "POST", token, operation: "relationships.create", body: JSON.stringify({ ...payload, client_request_id: requestId() }) }),
  update: (token: string, contact: RelationshipContact, payload: ContactFormPayload) => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}`, { method: "PATCH", token, operation: "relationships.update", body: JSON.stringify({ ...payload, revision: contact.revision, request_id: requestId() }) }),
  contacted: (token: string, contact: RelationshipContact, note: string) => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}/contacted`, { method: "POST", token, operation: "relationships.contacted", body: JSON.stringify({ revision: contact.revision, request_id: requestId(), contacted_at: new Date().toISOString(), channel: contact.preferred_channel, note }) }),
  snooze: (token: string, contact: RelationshipContact, minutes: number) => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}/snooze`, { method: "POST", token, operation: "relationships.snooze", body: JSON.stringify({ revision: contact.revision, request_id: requestId(), minutes }) }),
  reschedule: (token: string, contact: RelationshipContact, scheduledAt: string) => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}/reschedule`, { method: "POST", token, operation: "relationships.reschedule", body: JSON.stringify({ revision: contact.revision, request_id: requestId(), scheduled_at: scheduledAt }) }),
  status: (token: string, contact: RelationshipContact, action: "pause" | "resume" | "archive" | "restore") => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}/${action}`, { method: "POST", token, operation: `relationships.${action}`, body: JSON.stringify({ revision: contact.revision, request_id: requestId() }) }),
  retry: (token: string, contact: RelationshipContact) => apiFetch<RelationshipContact>(`/relationship-followups/${encodeURIComponent(contact.id)}/retry`, { method: "POST", token, operation: "relationships.retry", body: JSON.stringify({ revision: contact.revision, request_id: requestId() }) }),
  preferences: (token: string) => apiFetch<FollowupPreferences>("/relationship-followups/preferences", { token, operation: "relationships.preferences" }),
  updatePreferences: (token: string, payload: Pick<FollowupPreferences, "enabled" | "detailed_preview" | "permission_state">) => apiFetch<FollowupPreferences>("/relationship-followups/preferences", { method: "PUT", token, operation: "relationships.preferences.update", body: JSON.stringify(payload) }),
  suggest: (token: string, id: string, payload: { language: "hi" | "en"; tone: "friendly" | "formal" | "caring"; context: string }) => apiFetch<{ suggestion: string; model: string }>(`/relationship-followups/${encodeURIComponent(id)}/ai-suggestion`, { method: "POST", token, operation: "relationships.suggest", timeoutMs: 18000, body: JSON.stringify(payload) }),
};
