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

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
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

function clientRequestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export const sevaApi = {
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
};
