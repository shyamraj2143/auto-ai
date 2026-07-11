import type {
  AdminAnalytics,
  AdminFeaturesResponse,
  AdminFeatureFlag,
  AdminPaymentRecord,
  AdminPlanLimit,
  AdminPlanName,
  AdminQuota,
  AdminStats,
  AdminSubscription,
  AdminUsageResponse,
  AdminUser,
  ApkRelease,
  ApkStats,
  BillingCenter,
  Chat,
  ChatGeneration,
  ChatListItem,
  ChatRequest,
  DocumentItem,
  HumanState,
  InteractionProfile,
  FaceMemoryStatus,
  LiveMessageResponse,
  LiveSessionStart,
  PaymentConfig,
  PaymentSession,
  PromoCodeResponse,
  PaidPricingPlanName,
  ResponseModelInfo,
  ResearchModelOptions,
  RazorpayOrder,
  RazorpayVerifyResponse,
  RestorePurchaseResponse,
  SearchHistoryItem,
  SearchMode,
  SearchResultBundle,
  StreamEvent,
  TurnAnalysis,
  User,
  UsernameAvailability,
  UserRole,
  VisionAnalyzeResponse,
  UserMemory
} from "../types";
import { coerceTextContent } from "../utils/text";

declare global {
  interface Window {
    __AUTO_AI_API_URL__?: string;
  }
}

const PUBLIC_API_BASE_URL = "https://auto-ai-production-c510.up.railway.app/api/v1";

export type ApiErrorKind =
  | "network_unavailable"
  | "cors_blocked"
  | "server_unreachable"
  | "ssl_certificate_issue"
  | "authentication_failed"
  | "configuration_error"
  | "http_error";

type FetchOptions = Omit<RequestInit, "headers"> & {
  headers?: HeadersInit;
  token?: string | null;
  operation?: string;
  timeoutMs?: number;
};

export type AuthSession = {
  access_token: string;
  refresh_token?: string | null;
  token_type: string;
  user: User;
};

export type PasswordResetResult = {
  message: string;
  reset_url?: string | null;
};

type RequestMeta = {
  path?: string;
  method?: string;
  operation?: string;
};

type ApiContext = {
  apiUrl: string;
  apiOrigin: string;
  apiProtocol: string;
  apiHostname: string;
  pageOrigin: string;
  pageProtocol: string;
  crossOrigin: boolean;
  localPage: boolean;
  localApi: boolean;
  localApiFromPublicPage: boolean;
  mixedContent: boolean;
  online: boolean | "unknown";
  secureContext: boolean | "unknown";
  userAgent: string;
};

type ApiClientErrorOptions = {
  kind: ApiErrorKind;
  status?: number;
  url?: string;
  requestId?: string | null;
  details?: unknown;
  originalError?: unknown;
};

export class ApiClientError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly url?: string;
  readonly requestId?: string | null;
  readonly details?: unknown;
  readonly originalError?: unknown;

  constructor(message: string, options: ApiClientErrorOptions) {
    super(message);
    this.name = "ApiClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.url = options.url;
    this.requestId = options.requestId;
    this.details = options.details;
    this.originalError = options.originalError;
  }
}

function isBrowser() {
  return typeof window !== "undefined";
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeApiUrl(value?: string) {
  const trimmed = value?.trim();
  return trimmed ? stripTrailingSlash(trimmed) : "";
}

function configuredApiUrl() {
  const runtimeUrl = isBrowser() ? normalizeApiUrl(window.__AUTO_AI_API_URL__) : "";
  return runtimeUrl || normalizeApiUrl(import.meta.env.VITE_API_URL);
}

function resolveApiBaseUrl() {
  const runtimeUrl = isBrowser() ? normalizeApiUrl(window.__AUTO_AI_API_URL__) : "";
  const configured = runtimeUrl || normalizeApiUrl(import.meta.env.VITE_API_URL);
  if (!isBrowser()) return configured || PUBLIC_API_BASE_URL;

  const pageUrl = window.location;
  const localPage = pageUrl.hostname === "localhost" || pageUrl.hostname === "127.0.0.1";
  if (!configured && localPage && pageUrl.protocol === "http:") {
    return "http://localhost:8000/api/v1";
  }
  if (!configured) return PUBLIC_API_BASE_URL;

  try {
    const configuredUrl = new URL(configured, pageUrl.origin);
    if (pageUrl.protocol === "https:" && configuredUrl.protocol === "http:") return PUBLIC_API_BASE_URL;
  } catch {
    return PUBLIC_API_BASE_URL;
  }

  return configured;
}

export const API_BASE_URL = resolveApiBaseUrl();
export const APK_DOWNLOAD_URL = API_BASE_URL.replace(/\/api\/v1\/?$/, "/api").replace(/\/+$/, "") + "/download/apk";

export function resolveApiAssetUrl(value?: string | null) {
  if (!value) return "";
  if (/^(https?:)?\/\//i.test(value) || value.startsWith("data:")) return value;
  const apiOrigin = API_BASE_URL.replace(/\/api\/v1\/?$/, "");
  return `${apiOrigin}${value.startsWith("/") ? value : `/${value}`}`;
}

export function resolveApkDownloadUrl(
  release?: Pick<ApkRelease, "apk_url" | "download_url"> | null,
  counted = false
) {
  const rawUrl = release?.download_url || release?.apk_url || APK_DOWNLOAD_URL;
  const apiOrigin = API_BASE_URL.replace(/\/api\/v1\/?$/, "");
  const url = new URL(rawUrl, apiOrigin);
  if (counted && url.pathname.endsWith("/api/download/apk")) {
    url.searchParams.set("counted", "true");
  }
  return url.toString();
}

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

function getApiContext(url: string): ApiContext {
  if (!isBrowser()) {
    return {
      apiUrl: url,
      apiOrigin: "unknown",
      apiProtocol: "unknown",
      apiHostname: "unknown",
      pageOrigin: "unknown",
      pageProtocol: "unknown",
      crossOrigin: false,
      localPage: false,
      localApi: false,
      localApiFromPublicPage: false,
      mixedContent: false,
      online: "unknown",
      secureContext: "unknown",
      userAgent: "unknown"
    };
  }

  try {
    const apiUrl = new URL(url, window.location.origin);
    return {
      apiUrl: apiUrl.toString(),
      apiOrigin: apiUrl.origin,
      apiProtocol: apiUrl.protocol,
      apiHostname: apiUrl.hostname,
      pageOrigin: window.location.origin,
      pageProtocol: window.location.protocol,
      crossOrigin: apiUrl.origin !== window.location.origin,
      localPage: false,
      localApi: false,
      localApiFromPublicPage: false,
      mixedContent: window.location.protocol === "https:" && apiUrl.protocol === "http:",
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent
    };
  } catch {
    return {
      apiUrl: url,
      apiOrigin: "invalid",
      apiProtocol: "invalid",
      apiHostname: "invalid",
      pageOrigin: window.location.origin,
      pageProtocol: window.location.protocol,
      crossOrigin: false,
      localPage: false,
      localApi: false,
      localApiFromPublicPage: false,
      mixedContent: false,
      online: navigator.onLine,
      secureContext: window.isSecureContext,
      userAgent: navigator.userAgent
    };
  }
}

function isCertificateLikeError(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ssl|tls|certificate|cert_|err_cert/i.test(text);
}

function healthProbeUrl() {
  return `${API_BASE_URL}/health`;
}

async function canReachApiHostWithoutCors() {
  if (!isBrowser()) return false;
  try {
    await fetch(healthProbeUrl(), {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit"
    });
    return true;
  } catch {
    return false;
  }
}

async function canReachApiWithCors() {
  if (!isBrowser()) return false;
  try {
    const response = await fetch(healthProbeUrl(), {
      method: "GET",
      cache: "no-store",
      credentials: "omit"
    });
    return response.ok;
  } catch {
    return false;
  }
}

function logApiIssue(error: ApiClientError, context: ApiContext, meta: RequestMeta = {}) {
  if (!isBrowser()) return;

  const buildTimeApiUrl = normalizeApiUrl(import.meta.env.VITE_API_URL);
  const runtimeApiUrl = normalizeApiUrl(window.__AUTO_AI_API_URL__);
  const request = {
    operation: meta.operation,
    method: meta.method,
    path: meta.path,
    url: error.url ?? context.apiUrl,
    status: error.status,
    requestId: error.requestId,
    apiBaseUrl: API_BASE_URL
  };
  const browser = {
    pageOrigin: context.pageOrigin,
    apiOrigin: context.apiOrigin,
    crossOrigin: context.crossOrigin,
    localApiFromPublicPage: context.localApiFromPublicPage,
    mixedContent: context.mixedContent,
    online: context.online,
    secureContext: context.secureContext,
    userAgent: context.userAgent
  };
  const configuration = {
    buildTimeApiUrl: buildTimeApiUrl ? "set" : "empty",
    runtimeApiUrl: runtimeApiUrl ? "set" : "empty"
  };

  console.groupCollapsed(`[Auto-AI API] ${error.kind}: ${error.message}`);
  console.info("request", request);
  console.info("browser", browser);
  console.info("configuration", configuration);
  if (error.details) console.info("details", error.details);
  if (error.originalError) console.error("originalError", error.originalError);
  console.groupEnd();
}

async function createConnectionError(input: string, originalError: unknown, meta: RequestMeta = {}) {
  const context = getApiContext(input);
  let kind: ApiErrorKind = "server_unreachable";
  let message = `Server unreachable: Auto-AI API did not respond at ${context.apiOrigin}.`;

  if (context.online === false) {
    kind = "network_unavailable";
    message = "Network unavailable: your browser is offline or mobile data/Wi-Fi is not connected.";
  } else if (context.mixedContent) {
    kind = "ssl_certificate_issue";
    message = "SSL / mixed-content issue: the site is HTTPS but the API URL is HTTP. Use a public HTTPS API URL.";
  } else if (isCertificateLikeError(originalError)) {
    kind = "ssl_certificate_issue";
    message = "SSL certificate issue: the browser rejected the API connection certificate.";
  } else if (context.crossOrigin) {
    if (await canReachApiWithCors()) {
      message = "Connection interrupted. Please retry.";
    } else if (await canReachApiHostWithoutCors()) {
      kind = "cors_blocked";
      message = `CORS blocked: ${context.apiOrigin} is reachable, but it is not allowing requests from ${context.pageOrigin}.`;
    }
  }

  const error = new ApiClientError(message, {
    kind,
    url: context.apiUrl,
    originalError
  });
  logApiIssue(error, context, meta);
  return error;
}

function createTimeoutError(input: string, timeoutMs: number, meta: RequestMeta = {}) {
  const context = getApiContext(input);
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const error = new ApiClientError(`Server timeout: Auto-AI API did not respond within ${seconds}s. Please retry.`, {
    kind: "server_unreachable",
    url: context.apiUrl,
  });
  logApiIssue(error, context, meta);
  return error;
}

function createHttpError(
  status: number,
  statusText: string,
  payload: unknown,
  url: string,
  requestId: string | null,
  meta: RequestMeta = {}
) {
  const detail = getErrorMessage(payload, statusText || "Request failed");
  const authFailed = status === 401 || status === 403;
  const message = authFailed
    ? `Authentication failed: ${detail}`
    : `Request failed (${status}): ${detail}`;
  const error = new ApiClientError(message, {
    kind: authFailed ? "authentication_failed" : "http_error",
    status,
    url,
    requestId,
    details: payload
  });
  logApiIssue(error, getApiContext(url), meta);
  return error;
}

async function readErrorPayload(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return { detail: response.statusText };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { detail: text };
  }
}

async function fetchWithNetworkMessage(input: string, init: RequestInit = {}, meta: RequestMeta = {}, timeoutMs = 0) {
  const method = meta.method ?? init.method ?? "GET";
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const originalSignal = init.signal;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortFromOriginal = () => controller?.abort(originalSignal?.reason);
  if (controller) {
    if (originalSignal?.aborted) abortFromOriginal();
    else originalSignal?.addEventListener("abort", abortFromOriginal, { once: true });
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  try {
    return await fetch(input, {
      credentials: "omit",
      ...init,
      signal: controller?.signal ?? init.signal
    });
  } catch (error) {
    if (timedOut) {
      throw createTimeoutError(input, timeoutMs, { ...meta, method });
    }
    if (error instanceof TypeError) {
      throw await createConnectionError(input, error, { ...meta, method });
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    originalSignal?.removeEventListener("abort", abortFromOriginal);
  }
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { token, operation, timeoutMs = 15000, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  const method = requestOptions.method ?? "GET";
  const url = `${API_BASE_URL}${path}`;

  if (!(requestOptions.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetchWithNetworkMessage(
    url,
    {
      ...requestOptions,
      credentials: requestOptions.credentials ?? "include",
      headers
    },
    { path, method, operation },
    timeoutMs
  );

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    throw createHttpError(
      response.status,
      response.statusText,
      payload,
      url,
      response.headers.get("x-railway-request-id") ?? response.headers.get("x-request-id"),
      { path, method, operation }
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export const api = {
  register: (payload: { email: string; name: string; password: string; mobile?: string | null }) =>
    apiFetch<AuthSession>("/auth/register", {
      method: "POST",
      operation: "auth.register",
      body: JSON.stringify(payload)
    }),
  login: (payload: { email: string; password: string }) =>
    apiFetch<AuthSession>("/auth/login", {
      method: "POST",
      operation: "auth.login",
      body: JSON.stringify(payload)
    }),
  requestPasswordReset: (payload: { email: string }) =>
    apiFetch<PasswordResetResult>("/auth/password/forgot", {
      method: "POST",
      operation: "auth.password.forgot",
      body: JSON.stringify(payload)
    }),
  resetPassword: (payload: { token: string; password: string }) =>
    apiFetch<PasswordResetResult>("/auth/password/reset", {
      method: "POST",
      operation: "auth.password.reset",
      body: JSON.stringify(payload)
    }),
  googleConfig: () =>
    apiFetch<{ enabled: boolean; client_id?: string | null }>("/auth/google/config", {
      operation: "auth.google.config"
    }),
  googleLogin: (payload: { id_token: string }) =>
    apiFetch<AuthSession>("/auth/google", {
      method: "POST",
      operation: "auth.google",
      body: JSON.stringify(payload)
    }),
  refreshSession: (refreshToken?: string | null) =>
    apiFetch<AuthSession>("/auth/refresh", {
      method: "POST",
      operation: "auth.refresh",
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined
    }),
  logout: (token?: string | null, refreshToken?: string | null) =>
    apiFetch<void>("/auth/logout", {
      method: "POST",
      token,
      operation: "auth.logout",
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined
    }),
  me: (token: string) => apiFetch<User>("/auth/me", { token, operation: "auth.me" }),
  profile: (token: string) => apiFetch<User>("/users/me", { token, operation: "users.me" }),
  updateProfile: (token: string, payload: Partial<Pick<User, "name" | "username" | "phone_number" | "phone_country_code">>) =>
    apiFetch<User>("/users/me", { method: "PATCH", token, operation: "users.me.update", body: JSON.stringify(payload) }),
  uploadAvatar: (token: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiFetch<User>("/users/me/avatar", { method: "POST", token, operation: "users.me.avatar", body: formData, timeoutMs: 60000 });
  },
  deleteAvatar: (token: string) => apiFetch<void>("/users/me/avatar", { method: "DELETE", token, operation: "users.me.avatar.delete" }),
  usernameAvailable: (token: string, username: string) =>
    apiFetch<UsernameAvailability>(`/users/username-available?username=${encodeURIComponent(username)}`, { token, operation: "users.usernameAvailable" }),

  listChats: (token: string) => apiFetch<ChatListItem[]>("/chat/sessions", { token, operation: "chat.sessions.list" }),
  createChat: (token: string, payload: { title?: string; system_prompt?: string; model?: string; mode?: ChatRequest["mode"] }) =>
    apiFetch<Chat>("/chat/sessions", { method: "POST", token, operation: "chat.sessions.create", body: JSON.stringify(payload) }),
  getChat: (token: string, id: string) => apiFetch<Chat>(`/chat/sessions/${id}`, { token, operation: "chat.sessions.get" }),
  updateChat: (token: string, id: string, payload: { title?: string; system_prompt?: string; model?: string; mode?: ChatRequest["mode"]; clear_messages?: boolean }) =>
    apiFetch<Chat>(`/chat/sessions/${id}`, { method: "PATCH", token, operation: "chat.sessions.update", body: JSON.stringify(payload) }),
  deleteChat: (token: string, id: string) => apiFetch<void>(`/chat/sessions/${id}`, { method: "DELETE", token, operation: "chat.sessions.delete" }),

  listDocuments: (token: string) => apiFetch<DocumentItem[]>("/documents", { token, operation: "documents.list" }),
  uploadDocument: (token: string, formData: FormData) =>
    apiFetch<DocumentItem>("/documents/upload", { method: "POST", token, operation: "documents.upload", body: formData, timeoutMs: 300000 }),
  uploadDocumentWithProgress: (
    token: string,
    formData: FormData,
    onProgress: (progress: number) => void
  ) =>
    new Promise<DocumentItem>((resolve, reject) => {
      const url = `${API_BASE_URL}/documents/upload`;
      const meta = { path: "/documents/upload", method: "POST", operation: "documents.uploadWithProgress" };
      const request = new XMLHttpRequest();
      request.open("POST", url);
      request.timeout = 5 * 60 * 1000;
      request.setRequestHeader("Authorization", `Bearer ${token}`);
      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        onProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        const payload = request.responseText
          ? (() => {
              try {
                return JSON.parse(request.responseText) as unknown;
              } catch {
                return { detail: request.statusText };
              }
            })()
          : undefined;
        if (request.status >= 200 && request.status < 300) {
          resolve(payload as DocumentItem);
          return;
        }
        reject(
          createHttpError(
            request.status,
            request.statusText,
            payload,
            url,
            request.getResponseHeader("x-railway-request-id") ?? request.getResponseHeader("x-request-id"),
            meta
          )
        );
      };
      request.onerror = () => {
        void createConnectionError(url, new Error("XMLHttpRequest network error"), meta).then(reject);
      };
      request.ontimeout = () => {
        void createConnectionError(url, new Error("XMLHttpRequest upload timeout"), meta).then(reject);
      };
      request.send(formData);
    }),
  deleteDocument: (token: string, id: string) => apiFetch<void>(`/documents/${id}`, { method: "DELETE", token, operation: "documents.delete" }),
  analyzeImage: (token: string, file: File, prompt: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("prompt", prompt);
    return apiFetch<{ content: string; model: string }>("/ai/image-analysis", {
      method: "POST",
      token,
      operation: "ai.imageAnalysis",
      body: formData,
      timeoutMs: 120000
    });
  },

  humanProfile: (token: string) => apiFetch<InteractionProfile>("/human/profile", { token, operation: "human.profile" }),
  humanState: (token: string) => apiFetch<HumanState>("/human/state", { token, operation: "human.state" }),
  listMemories: (token: string, category?: string) =>
    apiFetch<UserMemory[]>(`/human/memories${category ? `?category=${encodeURIComponent(category)}` : ""}`, {
      token,
      operation: "human.memories.list"
    }),
  createMemory: (
    token: string,
    payload: { category: string; key: string; value: string; confidence?: number; source?: string }
  ) => apiFetch<UserMemory>("/human/memories", { method: "POST", token, operation: "human.memories.create", body: JSON.stringify(payload) }),
  updateMemory: (
    token: string,
    id: string,
    payload: { category?: string; key?: string; value?: string; confidence?: number; source?: string }
  ) => apiFetch<UserMemory>(`/human/memories/${id}`, { method: "PATCH", token, operation: "human.memories.update", body: JSON.stringify(payload) }),
  deleteMemory: (token: string, id: string) =>
    apiFetch<void>(`/human/memories/${id}`, { method: "DELETE", token, operation: "human.memories.delete" }),
  listTurnAnalyses: (token: string, params: { chat_id?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.chat_id) search.set("chat_id", params.chat_id);
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return apiFetch<TurnAnalysis[]>(`/human/turns${suffix}`, { token, operation: "human.turns.list" });
  },

  transcribeAudio: (token: string, blob: Blob, filename = "voice.webm") => {
    const formData = new FormData();
    formData.append("file", blob, filename);
    return apiFetch<{ text: string; model: string }>("/voice/transcribe", {
      method: "POST",
      token,
      operation: "voice.transcribe",
      body: formData,
      timeoutMs: 120000
    });
  },

  startLiveSession: (token: string) =>
    apiFetch<LiveSessionStart>("/live/start", {
      method: "POST",
      token,
      operation: "live.session.start"
    }),
  sendLiveMessage: (
    token: string,
    payload: {
      session_id: string;
      text?: string;
      transcript?: string;
      camera_context_id?: string | null;
      image_frame_id?: string | null;
      image_base64?: string | null;
      provider?: string | null;
      model?: string | null;
      language?: string | null;
    }
  ) =>
    apiFetch<LiveMessageResponse>("/live/message", {
      method: "POST",
      token,
      operation: "live.message",
      body: JSON.stringify(payload),
      timeoutMs: 90000
    }),
  analyzeLiveVision: (token: string, formData: FormData) =>
    apiFetch<VisionAnalyzeResponse>("/live/vision/analyze", {
      method: "POST",
      token,
      operation: "live.vision.analyze",
      body: formData,
      timeoutMs: 60000
    }),
  endLiveSession: (token: string, sessionId: string) =>
    apiFetch<{ session_id: string; status: string; ended_at: string }>("/live/end", {
      method: "POST",
      token,
      operation: "live.session.end",
      body: JSON.stringify({ session_id: sessionId })
    }),
  faceMemoryStatus: (token: string) =>
    apiFetch<FaceMemoryStatus>("/memory/face/status", {
      token,
      operation: "memory.face.status"
    }),
  enrollFaceMemory: (token: string, formData: FormData) =>
    apiFetch<FaceMemoryStatus>("/memory/face/enroll", {
      method: "POST",
      token,
      operation: "memory.face.enroll",
      body: formData,
      timeoutMs: 60000
    }),
  deleteFaceMemory: (token: string) =>
    apiFetch<void>("/memory/face", {
      method: "DELETE",
      token,
      operation: "memory.face.delete"
    }),

  runSearch: (token: string, payload: { query: string; mode?: ChatRequest["search_mode"] }) =>
    apiFetch<SearchResultBundle>("/search", {
      method: "POST",
      token,
      operation: "search.run",
      body: JSON.stringify(payload),
      timeoutMs: 60000
    }),
  searchHistory: (token: string) => apiFetch<SearchHistoryItem[]>("/search/history", { token, operation: "search.history" }),

  latestApk: () => apiFetch<ApkRelease>("/download/apk/latest", { operation: "download.apk.latest" }),
  apkVersions: () => apiFetch<ApkRelease[]>("/download/apk/versions", { operation: "download.apk.versions" }),
  apkStats: () => apiFetch<ApkStats>("/download/apk/stats", { operation: "download.apk.stats" }),
  countApkDownload: (payload: { id?: string; version_name?: string; version_code?: number } = {}) =>
    apiFetch<ApkRelease>("/download/apk/count", {
      method: "POST",
      operation: "download.apk.count",
      body: JSON.stringify(payload)
    }),
  uploadApkRelease: (token: string, formData: FormData) =>
    apiFetch<ApkRelease>("/download/apk/releases", {
      method: "POST",
      token,
      operation: "download.apk.upload",
      body: formData,
      timeoutMs: 300000
    }),
  updateApkRelease: (
    token: string,
    id: string,
    payload: Partial<Pick<ApkRelease, "changelog" | "force_update" | "release_notes" | "is_active">>
  ) =>
    apiFetch<ApkRelease>(`/download/apk/versions/${id}`, {
      method: "PATCH",
      token,
      operation: "download.apk.update",
      body: JSON.stringify(payload)
    }),
  adminUpsertApkVersion: (token: string, payload: {
    id?: string | null;
    version_code: number;
    version_name: string;
    apk_url: string;
    file_name?: string | null;
    file_size?: number;
    changelog?: string;
    force_update?: boolean;
    is_active?: boolean;
    released_at?: string | null;
    min_android_version?: string;
    release_notes?: string[];
  }) =>
    apiFetch<ApkRelease>("/admin/apk/version", {
      method: "POST",
      token,
      operation: "admin.apk.version.upsert",
      body: JSON.stringify(payload)
    }),

  paymentConfig: () => apiFetch<PaymentConfig>("/payments/config", { operation: "payments.config" }),
  billingCenter: (token: string) => apiFetch<BillingCenter>("/payments/billing", { token, operation: "payments.billing" }),
  applyPromoCode: (token: string, payload: { code: string; plan: PaidPricingPlanName }) =>
    apiFetch<PromoCodeResponse>("/payments/promo-code", {
      method: "POST",
      token,
      operation: "payments.promo",
      body: JSON.stringify(payload)
    }),
  updateAutoRenewal: (token: string, autoRenewal: boolean) =>
    apiFetch<BillingCenter["current_plan"]>("/payments/auto-renewal", {
      method: "PATCH",
      token,
      operation: "payments.autoRenewal",
      body: JSON.stringify({ auto_renewal: autoRenewal })
    }),
  restorePurchase: (token: string) =>
    apiFetch<RestorePurchaseResponse>("/payments/restore-purchase", {
      method: "POST",
      token,
      operation: "payments.restore"
    }),
  createRazorpayOrder: (
    token: string,
    payload: {
      plan_id: PaidPricingPlanName;
      amount: number;
      currency: string;
      receipt?: string;
      promo_code?: string | null;
    }
  ) =>
    apiFetch<RazorpayOrder>("/payments/create-order", {
      method: "POST",
      token,
      operation: "payments.createOrder",
      body: JSON.stringify(payload)
    }),
  createPaymentSession: (
    token: string,
    payload: {
      plan_id: PaidPricingPlanName;
      amount?: number | null;
      currency?: string;
      receipt?: string;
      promo_code?: string | null;
    }
  ) =>
    apiFetch<PaymentSession>("/payments/create-session", {
      method: "POST",
      token,
      operation: "payments.createSession",
      body: JSON.stringify(payload)
    }),
  paymentSession: (sessionId: string) =>
    apiFetch<PaymentSession>(`/payments/sessions/${encodeURIComponent(sessionId)}`, {
      operation: "payments.session"
    }),
  verifyRazorpayPayment: (
    token: string | null,
    payload: {
      razorpay_payment_id: string;
      razorpay_order_id: string;
      razorpay_signature: string;
      plan_id?: PaidPricingPlanName;
      amount?: number;
      currency?: string;
    }
  ) =>
    apiFetch<RazorpayVerifyResponse>("/payments/verify-payment", {
      method: "POST",
      token: token || undefined,
      operation: "payments.verify",
      body: JSON.stringify(payload)
    }),

  researchModels: (token: string) => apiFetch<ResearchModelOptions>("/ai/research-models", { token, operation: "ai.researchModels" }),
  startChatGeneration: (token: string, payload: ChatRequest) =>
    apiFetch<ChatGeneration>(payload.chat_id ? `/chat/sessions/${payload.chat_id}/messages` : "/ai/chat/generations", {
      method: "POST",
      token,
      operation: payload.chat_id ? "chat.sessions.messages.create" : "ai.chat.generations.start",
      body: JSON.stringify(payload),
      timeoutMs: 120000
    }),
  regenerateChatSession: (token: string, sessionId: string, payload: Omit<Partial<ChatRequest>, "message" | "chat_id"> & { message_id?: string }) =>
    apiFetch<ChatGeneration>(`/chat/sessions/${sessionId}/regenerate`, {
      method: "POST",
      token,
      operation: "chat.sessions.regenerate",
      body: JSON.stringify(payload),
      timeoutMs: 120000
    }),
  stopChatSession: (token: string, sessionId: string) =>
    apiFetch<ChatGeneration>(`/chat/sessions/${sessionId}/stop`, {
      method: "POST",
      token,
      operation: "chat.sessions.stop"
    }),
  activeChatGenerations: (token: string) =>
    apiFetch<ChatGeneration[]>("/ai/chat/generations/active", {
      token,
      operation: "ai.chat.generations.active"
    }),
  getChatGeneration: (token: string, generationId: string) =>
    apiFetch<ChatGeneration>(`/ai/chat/generations/${generationId}`, {
      token,
      operation: "ai.chat.generations.get"
    }),
  cancelChatGeneration: (token: string, generationId: string) =>
    apiFetch<ChatGeneration>(`/ai/chat/generations/${generationId}/cancel`, {
      method: "POST",
      token,
      operation: "ai.chat.generations.cancel"
    }),

  adminStats: (token: string) => apiFetch<AdminStats>("/admin/stats", { token, operation: "admin.stats" }),
  adminUsers: (token: string, params: { search?: string; role?: string; status?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.search) search.set("search", params.search);
    if (params.role) search.set("role", params.role);
    if (params.status) search.set("status", params.status);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return apiFetch<AdminUser[]>(`/admin/users${suffix}`, { token, operation: "admin.users.list" });
  },
  adminUser: (token: string, id: string) => apiFetch<AdminUser>(`/admin/users/${id}`, { token, operation: "admin.users.get" }),
  adminUserQuota: (token: string, id: string) =>
    apiFetch<AdminQuota>(`/admin/users/${id}/quota`, { token, operation: "admin.users.quota" }),
  updateAdminUserQuota: (
    token: string,
    id: string,
    payload: Partial<Pick<AdminQuota, "token_limit_monthly" | "daily_message_limit" | "bonus_tokens" | "plan_name">> & { force?: boolean }
  ) =>
    apiFetch<AdminQuota>(`/admin/users/${id}/quota`, {
      method: "PATCH",
      token,
      operation: "admin.users.quota.update",
      body: JSON.stringify(payload)
    }),
  addAdminUserTokens: (token: string, id: string, payload: { amount: number; reason: string }) =>
    apiFetch<AdminQuota>(`/admin/users/${id}/tokens/add`, {
      method: "POST",
      token,
      operation: "admin.users.tokens.add",
      body: JSON.stringify(payload)
    }),
  deductAdminUserTokens: (token: string, id: string, payload: { amount: number; reason: string }) =>
    apiFetch<AdminQuota>(`/admin/users/${id}/tokens/deduct`, {
      method: "POST",
      token,
      operation: "admin.users.tokens.deduct",
      body: JSON.stringify(payload)
    }),
  resetAdminUserTokens: (token: string, id: string) =>
    apiFetch<AdminQuota>(`/admin/users/${id}/tokens/reset`, {
      method: "POST",
      token,
      operation: "admin.users.tokens.reset"
    }),
  updateAdminUserStatus: (token: string, id: string, isActive: boolean) =>
    apiFetch<AdminUser>(`/admin/users/${id}/status`, {
      method: "PATCH",
      token,
      operation: "admin.users.status",
      body: JSON.stringify({ is_active: isActive })
    }),
  createAdminUser: (token: string, payload: { name: string; email: string; password: string; role: Extract<UserRole, "admin" | "super_admin"> }) =>
    apiFetch<AdminUser>("/admin/users/create-admin", {
      method: "POST",
      token,
      operation: "admin.users.createAdmin",
      body: JSON.stringify(payload)
    }),
  updateAdminUserRole: (token: string, id: string, role: UserRole) =>
    apiFetch<AdminUser>(`/admin/users/${id}/role`, {
      method: "PATCH",
      token,
      operation: "admin.users.role",
      body: JSON.stringify({ role })
    }),
  resetAdminUserPassword: (token: string, id: string, newPassword: string) =>
    apiFetch<AdminUser>(`/admin/users/${id}/reset-password`, {
      method: "PATCH",
      token,
      operation: "admin.users.resetPassword",
      body: JSON.stringify({ new_password: newPassword })
    }),
  deleteAdminUser: (token: string, id: string) =>
    apiFetch<void>(`/admin/users/${id}`, { method: "DELETE", token, operation: "admin.users.delete" }),
  adminSubscriptions: (token: string) =>
    apiFetch<AdminSubscription[]>("/admin/subscriptions", { token, operation: "admin.subscriptions.list" }),
  updateAdminSubscription: (
    token: string,
    userId: string,
    payload: Partial<Pick<
      AdminSubscription,
      | "plan"
      | "is_active"
      | "expires_at"
      | "payment_status"
      | "razorpay_customer_id"
      | "razorpay_payment_id"
      | "stripe_customer_id"
      | "stripe_payment_id"
      | "auto_renewal"
      | "is_lifetime"
    >>
  ) =>
    apiFetch<AdminSubscription>(`/admin/subscriptions/${userId}`, {
      method: "PATCH",
      token,
      operation: "admin.subscriptions.update",
      body: JSON.stringify(payload)
    }),
  activateLifetimeSubscription: (token: string, userId: string) =>
    apiFetch<AdminSubscription>(`/admin/subscriptions/${userId}/lifetime`, {
      method: "POST",
      token,
      operation: "admin.subscriptions.lifetime"
    }),
  suspendAdminSubscription: (token: string, userId: string) =>
    apiFetch<AdminSubscription>(`/admin/subscriptions/${userId}/suspend`, {
      method: "POST",
      token,
      operation: "admin.subscriptions.suspend"
    }),
  refundAdminPayment: (token: string, paymentId: string) =>
    apiFetch<AdminPaymentRecord>(`/admin/subscriptions/payments/${paymentId}/refund`, {
      method: "POST",
      token,
      operation: "admin.payments.refund"
    }),
  adminUsage: (token: string) => apiFetch<AdminUsageResponse>("/admin/usage", { token, operation: "admin.usage" }),
  adminFeatures: (token: string, userId?: string) =>
    apiFetch<AdminFeaturesResponse>(
      `/admin/features${userId ? `?user_id=${encodeURIComponent(userId)}` : ""}`,
      { token, operation: "admin.features" }
    ),
  updateAdminFeature: (token: string, key: string, enabled: boolean, userId?: string | null) =>
    apiFetch<AdminFeatureFlag>("/admin/features", {
      method: "PATCH",
      token,
      operation: "admin.features.update",
      body: JSON.stringify({ key, enabled, user_id: userId ?? null })
    }),
  updateAdminPlanLimit: (token: string, plan: AdminPlanName, payload: Partial<AdminPlanLimit>) =>
    apiFetch<AdminPlanLimit>(`/admin/features/plan-limits/${plan}`, {
      method: "PATCH",
      token,
      operation: "admin.planLimits.update",
      body: JSON.stringify(payload)
    }),
  adminAnalytics: (token: string) => apiFetch<AdminAnalytics>("/admin/analytics", { token, operation: "admin.analytics" }),
  adminPayments: (token: string) =>
    apiFetch<AdminPaymentRecord[]>("/admin/subscriptions/payments", { token, operation: "admin.payments" })
};

export async function streamChat(
  token: string,
  payload: ChatRequest,
  onEvent: (event: StreamEvent) => void
) {
  const path = "/ai/chat/stream";
  const url = `${API_BASE_URL}${path}`;
  const response = await fetchWithNetworkMessage(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    },
    { path, method: "POST", operation: "ai.chat.stream" }
  );

  if (!response.ok || !response.body) {
    const errorPayload = await readErrorPayload(response);
    throw createHttpError(
      response.status,
      response.statusText,
      errorPayload,
      url,
      response.headers.get("x-railway-request-id") ?? response.headers.get("x-request-id"),
      { path, method: "POST", operation: "ai.chat.stream" }
    );
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
      const parsedEvent = normalizeStreamEvent(JSON.parse(dataLine.replace(/^data:\s*/, "")));
      if (parsedEvent) onEvent(parsedEvent);
    }
  }
}

function normalizeStreamEvent(payload: unknown): StreamEvent | null {
  if (!payload || typeof payload !== "object" || !("type" in payload)) return null;
  const event = payload as Record<string, unknown>;
  if (event.type === "meta") {
    return {
      type: "meta",
      chat_id: coerceTextContent(event.chat_id),
      model: event.model && typeof event.model === "object" ? event.model as ResponseModelInfo : undefined
    };
  }
  if (event.type === "searching") {
    const rawMode = coerceTextContent(event.mode);
    const mode: SearchMode = ["off", "auto", "web", "news", "research", "deep"].includes(rawMode)
      ? (rawMode as SearchMode)
      : "auto";
    return {
      type: "searching",
      mode,
      message: coerceTextContent(event.message) || "Searching the web..."
    };
  }
  if (event.type === "sources" && event.search && typeof event.search === "object") {
    return { type: "sources", search: event.search as SearchResultBundle };
  }
  if (event.type === "delta") {
    return { type: "delta", delta: coerceTextContent(event.delta) };
  }
  if (event.type === "done") {
    return { type: "done", message_id: coerceTextContent(event.message_id) };
  }
  if (event.type === "error") {
    return { type: "error", detail: coerceTextContent(event.detail) || "Streaming failed" };
  }
  return null;
}
