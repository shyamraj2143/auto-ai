import { API_BASE_URL } from "../../api/client";
import type { ServiceIntentResponse, ServiceTaskView } from "../../types";

export type SevaApplicationPage = {
  items: ServiceTaskView[];
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
};

export type SevaRegistryItem = {
  id: string;
  name: string;
  provider: string;
  category: string;
  verified: boolean;
  execution_modes: string[];
  official_origin?: string | null;
  last_verified_at?: string | null;
};

export type SevaService = {
  id: string;
  version: string;
  name: string;
  name_hi?: string | null;
  provider: string;
  authority: string;
  category: string;
  department: string;
  country: string;
  region?: string | null;
  verified: boolean;
  confidence?: number | null;
  description: string;
  who_can_apply: string;
  application_mode: string;
  processing_information: string;
  expected_timeline: string;
  fee: { amount?: number | null; currency?: string; label?: string };
  eligibility: Array<{ description?: string }>;
  fields: Array<{ key: string; label: string; type: string; required?: boolean }>;
  documents: Array<{ key: string; label: string; required?: boolean; accepted?: string[]; max_bytes?: number }>;
  execution_modes: string[];
  authentication_type: string;
  tracking_method: string;
  protected_actions: string[];
  warnings: string[];
  official_source?: string | null;
  official_origin?: string | null;
  last_verified_at?: string | null;
  is_official_portal: false;
  disclaimer: string;
};

export type SevaDiscovery = {
  query: string;
  requires_confirmation: boolean;
  candidates: SevaService[];
  fallback?: SevaService | null;
};

export type SevaDraft = {
  id?: string | null;
  task_id: string;
  status: string;
  version: number;
  schema_version: string;
  values: Record<string, unknown>;
  warnings: Array<{ field: string; message: string }>;
  updated_at?: string | null;
};

export type SevaRequirement = {
  id: string;
  kind: "TEXT" | "DOCUMENT" | "PROTECTED_ACTION";
  field_key?: string | null;
  label: string;
  instructions: string;
  required: boolean;
  protected_action: boolean;
  status: "REQUESTED" | "FULFILLED" | "ACCEPTED" | "REJECTED" | string;
  response_text?: string | null;
  response_document?: { id: string; filename: string; content_type: string; file_size: number } | null;
  user_note?: string | null;
  requested_at: string;
  responded_at?: string | null;
  reviewed_at?: string | null;
};

export type SevaDeliverable = {
  id: string;
  kind: string;
  label: string;
  note?: string | null;
  verified_by_employee: boolean;
  document?: { id: string; filename: string; content_type: string; file_size: number } | null;
  created_at: string;
};

export type SevaWorkOrder = {
  id: string;
  case_id: string;
  task_id: string;
  handoff_id: string;
  status: "QUEUED" | "IN_PROGRESS" | "WAITING_USER" | "SUBMITTED" | "COMPLETED" | "CANCELLED" | string;
  priority: string;
  department?: string;
  queue_name?: string;
  request_summary: string;
  employee_note?: string | null;
  assigned_employee?: { id: string; name: string } | null;
  owner?: { id: string; name: string; email?: string | null; phone_number?: string | null } | null;
  service?: { id: string; name: string; provider: string } | null;
  task_state?: string | null;
  task_progress: number;
  work_progress: number;
  current_activity: string;
  reference_number?: string | null;
  official_status?: string | null;
  sla_status?: string;
  escalation_reason?: string | null;
  escalated_at?: string | null;
  quality_required?: boolean;
  quality_status?: string;
  quality_reviews?: Array<{ id: string; status: string; snapshot_version: number; decision_reason?: string | null; requested_at: string; reviewed_at?: string | null }>;
  submitted_at: string;
  due_at?: string | null;
  queue_position?: number | null;
  consent_scope: { field_keys?: string[]; document_ids?: string[]; authentication_secrets_shared?: boolean };
  requirements: SevaRequirement[];
  deliverables: SevaDeliverable[];
  timeline: Array<{ id: string; event_type: string; title: string; details: Record<string, unknown>; created_at: string }>;
  assignment_history?: Array<{ id: string; agent_user_id: string; reason: string; assigned_at: string; ended_at?: string | null; ended_reason?: string | null }>;
  claimed_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type SevaAgent = {
  id: string; user_id: string; agent_id: string; display_name: string; capacity: number;
  active_load: number; available_slots: number; is_active: boolean;
  last_assigned_at?: string | null; created_at: string;
  username: string; work_email?: string | null; contact_phone?: string | null;
  specializations: string[]; languages: string[]; status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  must_change_password: boolean; last_login_at?: string | null;
};

export type SevaNotification = {
  id: string; work_order_id: string; event_type: string; title: string; message: string;
  deep_link?: string | null; read_at?: string | null; created_at: string;
};

export type SevaStartResult = {
  matched: boolean;
  fallback_to_employee: boolean;
  message: string;
  task: ServiceTaskView;
};

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (Array.isArray(detail)) {
      const message = detail.map((item) => {
        if (item && typeof item === "object" && "msg" in item) return String((item as { msg: unknown }).msg);
        return "";
      }).filter(Boolean).join("; ");
      if (message) return message;
    }
  }
  return fallback;
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(payload, `Request failed (${response.status})`));
  return payload as T;
}

async function requestBlob(token: string, path: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(errorMessage(payload, `Download failed (${response.status})`));
  }
  return response.blob();
}

function clientRequestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

const operationsBase = "/form-services/seva-operations";

export const sevaApi = {
  discoverServices(token: string, query: string) {
    return request<SevaDiscovery>(token, `${operationsBase}/discover`, {
      method: "POST",
      body: JSON.stringify({ query, limit: 5 }),
    });
  },

  listCatalogue(token: string, category = "") {
    const suffix = category ? `?category=${encodeURIComponent(category)}` : "";
    return request<{ items: SevaService[]; categories: string[]; total: number }>(token, `${operationsBase}/catalogue${suffix}`);
  },

  getService(token: string, serviceId: string) {
    return request<SevaService>(token, `${operationsBase}/catalogue/${encodeURIComponent(serviceId)}`);
  },

  listApplications(token: string, options: { page?: number; pageSize?: number; state?: string; q?: string } = {}) {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      page_size: String(options.pageSize ?? 50),
    });
    if (options.state) params.set("state", options.state);
    if (options.q) params.set("q", options.q);
    return request<SevaApplicationPage>(token, `/form-services/tasks?${params.toString()}`);
  },

  getApplication(token: string, applicationId: string) {
    return request<ServiceTaskView>(token, `/form-services/tasks/${encodeURIComponent(applicationId)}`);
  },

  startRequest(token: string, query: string, locale = "hi-IN", serviceId?: string) {
    return request<SevaStartResult>(token, `${operationsBase}/start`, {
      method: "POST",
      body: JSON.stringify({
        query,
        service_id: serviceId || null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        locale,
        client_request_id: clientRequestId("seva-search"),
      }),
    });
  },

  async startIncomeCertificate(token: string, locale = "hi-IN") {
    const result = await request<ServiceIntentResponse>(token, "/form-services/interpret", {
      method: "POST",
      body: JSON.stringify({
        message: "मुझे बिहार का आय प्रमाण पत्र बनवाना है",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        locale,
        client_request_id: clientRequestId("seva-income"),
      }),
    });
    if (!result.handled || !result.task) throw new Error(result.reason || "Income Certificate service is unavailable.");
    return result.task;
  },

  async startIncomeCertificateDemo(token: string, locale = "hi-IN") {
    const registry = await request<SevaRegistryItem[]>(token, "/form-services/registry?q=Demo%20Bihar%20Income%20Certificate");
    const service = registry.find((item) => item.id === "autoai.demo-bihar-income-certificate") ?? registry[0];
    if (!service) throw new Error("The Income Certificate demo service is not ready on the server.");
    const created = await request<ServiceTaskView>(token, "/form-services/tasks", {
      method: "POST",
      body: JSON.stringify({
        service_id: service.id,
        chat_id: null,
        original_request: "Run the AutoAI Bihar Income Certificate demo",
        execution_mode: "EXECUTE_WITH_CONFIRMATION",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        locale,
        client_request_id: clientRequestId("seva-demo-income"),
      }),
    });
    return request<ServiceTaskView>(token, `/form-services/tasks/${encodeURIComponent(created.id)}/start`, {
      method: "POST",
      body: JSON.stringify({
        version: created.version,
        request_id: clientRequestId("seva-demo-start"),
        reason: "User started the Bihar Income Certificate safe demo",
      }),
    });
  },

  getAssistance(token: string, taskId: string) {
    return request<{ work_order: SevaWorkOrder | null }>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance`);
  },

  getDraft(token: string, taskId: string) {
    return request<SevaDraft>(token, `/form-services/tasks/${encodeURIComponent(taskId)}/draft`);
  },

  saveDraft(token: string, taskId: string, draftVersion: number, schemaVersion: string, values: Record<string, unknown>) {
    return request<SevaDraft>(token, `/form-services/tasks/${encodeURIComponent(taskId)}/draft`, {
      method: "PUT",
      body: JSON.stringify({ draft_version: draftVersion, schema_version: schemaVersion, values, request_id: clientRequestId("seva-draft") }),
    });
  },

  requestAssistance(token: string, taskId: string, purpose: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance`, {
      method: "POST",
      body: JSON.stringify({ purpose, consent_accepted: true }),
    });
  },

  cancelAssistance(token: string, taskId: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance/cancel`, { method: "POST" });
  },

  respondRequirementText(token: string, taskId: string, requirementId: string, value: string, note = "") {
    return request<SevaWorkOrder>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance/requirements/${encodeURIComponent(requirementId)}/text`, {
      method: "POST",
      body: JSON.stringify({ value, note: note || null }),
    });
  },

  respondRequirementDocument(token: string, taskId: string, requirementId: string, file: File, note = "") {
    const body = new FormData();
    body.append("file", file);
    body.append("note", note);
    return request<SevaWorkOrder>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance/requirements/${encodeURIComponent(requirementId)}/document`, {
      method: "POST",
      body,
    });
  },

  completeProtectedAction(token: string, taskId: string, requirementId: string, note = "") {
    return request<SevaWorkOrder>(token, `${operationsBase}/tasks/${encodeURIComponent(taskId)}/assistance/requirements/${encodeURIComponent(requirementId)}/protected-action`, {
      method: "POST",
      body: JSON.stringify({ completed: true, note: note || null }),
    });
  },

  downloadDeliverable(token: string, deliverableId: string) {
    return requestBlob(token, `${operationsBase}/deliverables/${encodeURIComponent(deliverableId)}/content`);
  },

  listNotifications(token: string) {
    return request<{ items: SevaNotification[]; unread: number }>(token, `${operationsBase}/notifications`);
  },

  markNotificationRead(token: string, notificationId: string) {
    return request<{ ok: boolean }>(token, `${operationsBase}/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST" });
  },

  listAgents(token: string) {
    return request<{ items: SevaAgent[]; total: number; summary: { active: number; inactive: number; suspended: number; at_capacity: number } }>(token, `${operationsBase}/admin/agents`);
  },

  getAgentProfile(token: string) {
    return request<SevaAgent>(token, `${operationsBase}/agent/me`);
  },

  changeAgentPassword(token: string, currentPassword: string, newPassword: string) {
    return request<{ ok: boolean }>(token, `${operationsBase}/agent/change-password`, { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
  },

  getAgentDashboard(token: string) {
    return request<{ agent: SevaAgent; counts: Record<string, number>; active_workload: number; completed_today: number; attention_required: number; recent_cases: SevaWorkOrder[] }>(token, `${operationsBase}/agent/dashboard`);
  },

  createAgent(token: string, payload: { agent_id: string; display_name: string; password: string; capacity: number; work_email?: string; contact_phone?: string; specializations?: string[]; languages?: string[] }) {
    return request<SevaAgent>(token, `${operationsBase}/admin/agents`, { method: "POST", body: JSON.stringify(payload) });
  },

  updateAgent(token: string, profileId: string, payload: { display_name?: string; password?: string; capacity?: number; is_active?: boolean; status?: "ACTIVE" | "INACTIVE" | "SUSPENDED"; work_email?: string; contact_phone?: string; specializations?: string[]; languages?: string[] }) {
    return request<SevaAgent>(token, `${operationsBase}/admin/agents/${encodeURIComponent(profileId)}`, { method: "PATCH", body: JSON.stringify(payload) });
  },

  reassignWorkOrder(token: string, workOrderId: string, agentProfileId: string | null, reason: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/reassign`, { method: "POST", body: JSON.stringify({ agent_profile_id: agentProfileId, reason }) });
  },

  listWorkOrders(token: string, options: { state?: string; q?: string; agentId?: string; priority?: string; sla?: string; department?: string; queue?: string; category?: string; dateFrom?: string; dateTo?: string; page?: number; pageSize?: number } = {}) {
    const params = new URLSearchParams({ page: String(options.page ?? 1), page_size: String(options.pageSize ?? 50) });
    if (options.state) params.set("state", options.state);
    if (options.q) params.set("q", options.q);
    if (options.agentId) params.set("agent_id", options.agentId);
    if (options.priority) params.set("priority", options.priority);
    if (options.sla) params.set("sla", options.sla);
    if (options.department) params.set("department", options.department);
    if (options.queue) params.set("queue", options.queue);
    if (options.category) params.set("category", options.category);
    if (options.dateFrom) params.set("date_from", options.dateFrom);
    if (options.dateTo) params.set("date_to", options.dateTo);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return request<{ items: SevaWorkOrder[]; total: number; page: number; page_size: number; has_more: boolean }>(token, `${operationsBase}/admin/work-orders${suffix}`);
  },

  getWorkOrder(token: string, workOrderId: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}`);
  },

  claimWorkOrder(token: string, workOrderId: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/claim`, { method: "POST" });
  },

  createRequirement(token: string, workOrderId: string, payload: { kind: "TEXT" | "DOCUMENT" | "PROTECTED_ACTION"; label: string; instructions: string; field_key?: string; required: boolean }) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/requirements`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  reviewRequirement(token: string, workOrderId: string, requirementId: string, accepted: boolean, note = "") {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/requirements/${encodeURIComponent(requirementId)}/review`, {
      method: "POST",
      body: JSON.stringify({ accepted, note: note || null }),
    });
  },

  downloadRequirementDocument(token: string, workOrderId: string, requirementId: string) {
    return requestBlob(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/requirements/${encodeURIComponent(requirementId)}/document/content`);
  },

  updateWorkOrderStatus(token: string, workOrderId: string, status: SevaWorkOrder["status"], note = "", progressPercent?: number, referenceNumber?: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/status`, {
      method: "POST",
      body: JSON.stringify({ status, note: note || null, progress_percent: progressPercent, reference_number: referenceNumber || null }),
    });
  },

  uploadDeliverable(token: string, workOrderId: string, file: File, label: string, note: string, markCompleted = true) {
    const body = new FormData();
    body.append("file", file);
    body.append("label", label);
    body.append("note", note);
    body.append("mark_completed", String(markCompleted));
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/deliverables`, {
      method: "POST",
      body,
    });
  },

  requestQualityReview(token: string, workOrderId: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/quality-review`, { method: "POST" });
  },

  decideQualityReview(token: string, workOrderId: string, approved: boolean, reason = "") {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/quality-review/decision`, { method: "POST", body: JSON.stringify({ approved, reason: reason || null }) });
  },

  escalateWorkOrder(token: string, workOrderId: string, reason: string) {
    return request<SevaWorkOrder>(token, `${operationsBase}/admin/work-orders/${encodeURIComponent(workOrderId)}/escalate`, { method: "POST", body: JSON.stringify({ reason }) });
  },

  getOperationsOverview(token: string) {
    return request<{ total: number; counts: Record<string, number>; overdue: number; pending_quality_review: number; protected_actions: number; agents_available: number; agents_at_capacity: number }>(token, `${operationsBase}/admin/overview`);
  },
};
