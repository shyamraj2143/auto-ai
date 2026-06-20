import type {
  AdminStats,
  Chat,
  ChatListItem,
  ChatRequest,
  DocumentItem,
  HumanState,
  InteractionProfile,
  StreamEvent,
  TurnAnalysis,
  User,
  UserMemory
} from "../types";

export const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000/api/v1";

type FetchOptions = RequestInit & {
  token?: string | null;
};

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: unknown }).msg);
          }
          return "";
        })
        .filter(Boolean);
      if (messages.length) return messages.join("; ");
    }
  }
  return fallback;
}

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(getErrorMessage(payload, "Request failed"));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  register: (payload: { email: string; name: string; password: string }) =>
    apiFetch<{ access_token: string; token_type: string; user: User }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  login: (payload: { email: string; password: string }) =>
    apiFetch<{ access_token: string; token_type: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  me: (token: string) => apiFetch<User>("/auth/me", { token }),

  listChats: (token: string) => apiFetch<ChatListItem[]>("/chats", { token }),
  createChat: (token: string, payload: { title?: string; system_prompt?: string; model?: string }) =>
    apiFetch<Chat>("/chats", { method: "POST", token, body: JSON.stringify(payload) }),
  getChat: (token: string, id: string) => apiFetch<Chat>(`/chats/${id}`, { token }),
  updateChat: (token: string, id: string, payload: { title?: string; system_prompt?: string; model?: string }) =>
    apiFetch<Chat>(`/chats/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteChat: (token: string, id: string) => apiFetch<void>(`/chats/${id}`, { method: "DELETE", token }),

  listDocuments: (token: string) => apiFetch<DocumentItem[]>("/documents", { token }),
  uploadDocument: (token: string, formData: FormData) =>
    apiFetch<DocumentItem>("/documents/upload", { method: "POST", token, body: formData }),
  uploadDocumentWithProgress: (
    token: string,
    formData: FormData,
    onProgress: (progress: number) => void
  ) =>
    new Promise<DocumentItem>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `${API_BASE_URL}/documents/upload`);
      request.setRequestHeader("Authorization", `Bearer ${token}`);
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        const payload = request.responseText
          ? (() => {
              try {
                return JSON.parse(request.responseText);
              } catch {
                return { detail: request.statusText };
              }
            })()
          : undefined;
        if (request.status >= 200 && request.status < 300) {
          resolve(payload as DocumentItem);
          return;
        }
        reject(new Error(getErrorMessage(payload, "Document upload failed")));
      };
      request.onerror = () => reject(new Error("Document upload failed"));
      request.send(formData);
    }),
  deleteDocument: (token: string, id: string) => apiFetch<void>(`/documents/${id}`, { method: "DELETE", token }),
  analyzeImage: (token: string, file: File, prompt: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("prompt", prompt);
    return apiFetch<{ content: string; model: string }>("/ai/image-analysis", {
      method: "POST",
      token,
      body: formData
    });
  },

  humanProfile: (token: string) => apiFetch<InteractionProfile>("/human/profile", { token }),
  humanState: (token: string) => apiFetch<HumanState>("/human/state", { token }),
  listMemories: (token: string, category?: string) =>
    apiFetch<UserMemory[]>(`/human/memories${category ? `?category=${encodeURIComponent(category)}` : ""}`, {
      token
    }),
  createMemory: (
    token: string,
    payload: { category: string; key: string; value: string; confidence?: number; source?: string }
  ) => apiFetch<UserMemory>("/human/memories", { method: "POST", token, body: JSON.stringify(payload) }),
  updateMemory: (
    token: string,
    id: string,
    payload: { category?: string; key?: string; value?: string; confidence?: number; source?: string }
  ) => apiFetch<UserMemory>(`/human/memories/${id}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteMemory: (token: string, id: string) =>
    apiFetch<void>(`/human/memories/${id}`, { method: "DELETE", token }),
  listTurnAnalyses: (token: string, params: { chat_id?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.chat_id) search.set("chat_id", params.chat_id);
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return apiFetch<TurnAnalysis[]>(`/human/turns${suffix}`, { token });
  },

  transcribeAudio: (token: string, blob: Blob) => {
    const formData = new FormData();
    formData.append("file", blob, "voice.webm");
    return apiFetch<{ text: string; model: string }>("/voice/transcribe", {
      method: "POST",
      token,
      body: formData
    });
  },

  adminStats: (token: string) => apiFetch<AdminStats>("/admin/stats", { token })
};

export async function streamChat(
  token: string,
  payload: ChatRequest,
  onEvent: (event: StreamEvent) => void
) {
  const response = await fetch(`${API_BASE_URL}/ai/chat/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(getErrorMessage(error, "Unable to stream response"));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const dataLine = event
        .split("\n")
        .find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine.replace(/^data:\s*/, "")) as StreamEvent);
    }
  }
}
