import { API_BASE_URL } from "../../api/client";

export type SevaApprovedScope = {
  work_order_id: string;
  task_id: string;
  service_name: string;
  authentication_secrets_shared: false;
  fields: Array<{
    key: string;
    label: string;
    value: unknown;
    source: string;
    verified: boolean;
  }>;
  documents: Array<{
    asset_id: string;
    filename: string;
    content_type: string;
    file_size: number;
    validation_status: string;
    download_path: string;
  }>;
};

async function readError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object" && "message" in detail) return String((detail as { message?: unknown }).message || fallback);
  }
  return fallback;
}

export const sevaScopeApi = {
  async get(token: string, workOrderId: string) {
    const response = await fetch(`${API_BASE_URL}/form-services/seva-operations/admin/work-orders/${encodeURIComponent(workOrderId)}/scope`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(await readError(response, "Approved application data could not be loaded."));
    return response.json() as Promise<SevaApprovedScope>;
  },

  async downloadDocument(token: string, workOrderId: string, assetId: string) {
    const response = await fetch(`${API_BASE_URL}/form-services/seva-operations/admin/work-orders/${encodeURIComponent(workOrderId)}/documents/${encodeURIComponent(assetId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(await readError(response, "Approved document could not be downloaded."));
    return response.blob();
  },
};
