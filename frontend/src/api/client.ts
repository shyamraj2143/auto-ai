import type {
  AdminAnalytics,
  AdminAuditLogPage,
  AdminFeaturesResponse,
  AdminFeatureFlag,
  AdminPaymentPage,
  AdminPaymentRecord,
  AdminPlanLimit,
  AdminPlanName,
  AdminQuota,
  AdminStats,
  AdminSystemStatus,
  AdminSubscription,
  AdminUsageResponse,
  AdminUser,
  ApkRelease,
  ApkStats,
  BillingCenter,
  BillingPlan,
  Chat,
  ChatGeneration,
  ChatListItem,
  ChatRequest,
  DocumentItem,
  HumanState,
  InteractionProfile,
  IntelligenceConfig,
  IntentEngineResponse,
  LibraryAsset,
  LibraryAssetPage,
  LibraryAttachment,
  FaceMemoryStatus,
  LiveMessageResponse,
  LiveSessionStart,
  MessageFeedback,
  MessageFeedbackReason,
  OrchestrationActivityEvent,
  PaymentConfig,
  PaymentHistoryPage,
  PaymentSession,
  PromoCode,
  PromoCodePage,
  PromoCodePayload,
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
  ServiceIntentResponse,
  ServiceTaskView,
  StreamEvent,
  StripeCheckoutSession,
  TurnAnalysis,
  User,
  UsernameAvailability,
  UserRole,
  VisionAnalyzeResponse,
  UserMemory
} from "../types";
import { coerceTextContent } from "../utils/text";
import type { AssistantActionItem, AssistantResponse } from "../features/assistant/types";

declare global {
  interface Window {
    __AUTO_AI_API_URL__?: string;
  }
}

const PUBLIC_API_BASE_URL = "https://autoai.site.je/api/v1";
const API_V1_PREFIX = "/api/v1";
const DEFAULT_API_TIMEOUT_MS = 8000;
const API_DIAGNOSTIC_TIMEOUT_MS = 2500;
export const API_ENVIRONMENT = import.meta.env.MODE || "production";

export type ApiErrorKind =
  | "aborted"
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

export type DemoChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type DemoChatResult = {
  content: string;
  provider: "bedrock" | "groq" | "openai";
  model: string;
  messages_used: number;
  remaining: number;
};

export type DemoChatConfig = {
  enabled: boolean;
  provider: "bedrock" | "groq" | "openai";
  model: string;
  limit: number;
};

export type ApiHealth = {
  status: "ok";
  service: string;
};

export type ChatBackup = {
  schema: "autoai.chat-backup";
  schema_version: 1;
  exported_at: string;
  chats: Array<{
    id: string;
    title: string;
    model: string;
    mode: string;
    created_at: string;
    updated_at: string;
    messages: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; model?: string | null; token_count: number; created_at: string }>;
  }>;
};

export type BackupPreview = { valid: boolean; schema_version: number; backup_date: string; chat_count: number; message_count: number };
export type RestoreResult = { mode: "merge" | "replace"; chats_imported: number; chats_skipped: number; messages_imported: number };
export type UserUsage = {
  start_at: string;
  end_at: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  average_latency_ms: number;
  cache_hits: number;
  cache_misses: number;
  errors: number;
  buckets: Array<{ period: string; requests: number; input_tokens: number; output_tokens: number; total_tokens: number }>;
  dimensions: Array<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; total_tokens: number; average_latency_ms: number; cache_hits: number; cache_misses: number; errors: number }>;
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

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, "");
}

export function normalizeApiUrl(value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const absoluteCandidate = /^[A-Za-z0-9.-]+(?::\d+)?(?:\/|$)/.test(trimmed)
    ? `https://${trimmed}`
    : trimmed;

  try {
    const url = new URL(
      absoluteCandidate,
      isBrowser() ? window.location.origin : PUBLIC_API_BASE_URL
    );

    const normalizedPath = url.pathname
      .replace(/\/+/g, "/")
      .replace(/\/api\/v1(?:\/api\/v1)+\/?$/i, API_V1_PREFIX)
      .replace(/^\/+|\/+$/g, "");

    url.pathname = `/${normalizedPath}`;

    if (!/\/api\/v1$/i.test(url.pathname)) {
      url.pathname =
        `${url.pathname.replace(/\/+$/, "")}${API_V1_PREFIX}`;
    }

    return normalizeBaseUrl(url.toString());
  } catch {
    return "";
  }
}

function normalizeApiPath(path: string) {
  let normalized = path.trim().replace(/^\/+/, "");
  while (/^api\/v1(?=\/|$)/i.test(normalized)) {
    normalized = normalized.replace(/^api\/v1(?=\/|$)\/?/i, "").replace(/^\/+/, "");
  }
  return normalized ? `/${normalized}` : "/";
}

function joinApiUrl(base: string, path: string) {
  return `${normalizeBaseUrl(base)}/${normalizeApiPath(path).replace(/^\/+/, "")}`;
}

function configuredApiUrl() {
  const runtimeUrl = isBrowser() ? normalizeApiUrl(window.__AUTO_AI_API_URL__) : "";
  return runtimeUrl || normalizeApiUrl(import.meta.env.VITE_API_URL);
}

export function resolveUnconfiguredApiBaseUrl(
  page: Pick<Location, "hostname" | "protocol">,
  mobileApp: boolean
) {
  if (!mobileApp && page.protocol === "http:" && ["localhost", "127.0.0.1"].includes(page.hostname)) {
    return `http://${page.hostname}:8000${API_V1_PREFIX}`;
  }
  return PUBLIC_API_BASE_URL;
}

export function resolveLocalPreviewApiBaseUrl(
  page: Pick<Location, "hostname" | "protocol">,
  mobileApp: boolean,
  hasConfiguredOverride: boolean
) {
  if (
    !mobileApp
    && !hasConfiguredOverride
    && page.protocol === "http:"
    && ["localhost", "127.0.0.1"].includes(page.hostname)
  ) {
    return `http://${page.hostname}:8000${API_V1_PREFIX}`;
  }
  return "";
}

function resolveApiBaseUrl() {
  const rawRuntimeUrl = isBrowser() ? window.__AUTO_AI_API_URL__?.trim() || "" : "";
  const rawBuildUrl = import.meta.env.VITE_API_URL?.trim() || "";
  const rawConfigured = rawRuntimeUrl || rawBuildUrl;
  const runtimeUrl = normalizeApiUrl(rawRuntimeUrl);
  const configured = runtimeUrl || normalizeApiUrl(rawBuildUrl);
  if (!isBrowser()) return configured || PUBLIC_API_BASE_URL;

  const pageUrl = window.location;
  const capacitorPlatform = (window as Window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
  const mobileApp = capacitorPlatform === "android" || capacitorPlatform === "ios" || (pageUrl.protocol === "https:" && pageUrl.hostname === "localhost");
  const localPreviewUrl = resolveLocalPreviewApiBaseUrl(pageUrl, mobileApp, Boolean(configured));
  if (localPreviewUrl) return localPreviewUrl;
  if (!configured) return resolveUnconfiguredApiBaseUrl(pageUrl, mobileApp);
  if (mobileApp && !/^https:\/\//i.test(rawConfigured)) return PUBLIC_API_BASE_URL;

  try {
    const configuredUrl = new URL(configured, pageUrl.origin);
    if (mobileApp && ["localhost", "127.0.0.1"].includes(configuredUrl.hostname)) return PUBLIC_API_BASE_URL;
    if (pageUrl.protocol === "https:" && configuredUrl.protocol === "http:") return PUBLIC_API_BASE_URL;
  } catch {
    return PUBLIC_API_BASE_URL;
  }

  return configured;
}

export const API_BASE_URL = resolveApiBaseUrl();
export const WS_BASE_URL = (() => {
  const url = new URL(API_BASE_URL, isBrowser() ? window.location.origin : PUBLIC_API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/i, "");
  url.search = "";
  url.hash = "";
  return stripTrailingSlash(url.toString());
})();
export const APK_DOWNLOAD_URL = API_BASE_URL.replace(/\/api\/v1\/?$/, "/api").replace(/\/+$/, "") + "/download/apk";

export function createWebSocketUrl(path: string, params?: Record<string, string>) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, `${WS_BASE_URL}/`);
  if (params) url.search = new URLSearchParams(params).toString();
  return url.toString();
}

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

export function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (payload && typeof payload === "object" && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (detail && typeof detail === "object" && "message" in detail) {
      const field = "field" in detail ? String((detail as { field?: unknown }).field ?? "").trim() : "";
      const message = String((detail as { message?: unknown }).message ?? "").trim();
      if (message) return field ? `${field}: ${message}` : message;
    }
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) {
            const location = "loc" in item && Array.isArray((item as { loc?: unknown }).loc)
              ? (item as { loc: unknown[] }).loc.filter((part) => part !== "body").join(".")
              : "";
            const message = String((item as { msg: unknown }).msg);
            return location ? `${location}: ${message}` : message;
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
  return joinApiUrl(API_BASE_URL, "/health");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function canReachApiHostWithoutCors() {
  if (!isBrowser()) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_DIAGNOSTIC_TIMEOUT_MS);
  try {
    await fetch(healthProbeUrl(), {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function canReachApiWithCors() {
  if (!isBrowser()) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_DIAGNOSTIC_TIMEOUT_MS);
  try {
    const response = await fetch(healthProbeUrl(), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
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
  let message = "Auto-AI server is temporarily unavailable.";

  if (context.online === false) {
    kind = "network_unavailable";
    message = "You are offline. Check mobile data or Wi-Fi and retry.";
  } else if (context.mixedContent) {
    kind = "ssl_certificate_issue";
    message = "Auto-AI server configuration is invalid.";
  } else if (isCertificateLikeError(originalError)) {
    kind = "ssl_certificate_issue";
    message = "Auto-AI server certificate could not be verified.";
  } else if (context.crossOrigin) {
    if (await canReachApiWithCors()) {
      message = "Connection interrupted. Please retry.";
    } else if (await canReachApiHostWithoutCors()) {
      kind = "cors_blocked";
      message = "Auto-AI server is temporarily unavailable.";
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
  const error = new ApiClientError("Auto-AI server is temporarily unavailable. Please retry.", {
    kind: "server_unreachable",
    url: context.apiUrl,
  });
  logApiIssue(error, context, meta);
  return error;
}

function createAbortError(input: string, originalError: unknown, meta: RequestMeta = {}) {
  const context = getApiContext(input);
  const error = new ApiClientError("Request cancelled.", {
    kind: "aborted",
    url: context.apiUrl,
    originalError
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
    ? status === 401
      ? "Your session expired. Please sign in again."
      : detail || "You do not have permission for this action."
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
    if (isAbortError(error) || originalSignal?.aborted) {
      throw createAbortError(input, error, { ...meta, method });
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
  const { token, operation, timeoutMs = DEFAULT_API_TIMEOUT_MS, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  const method = requestOptions.method ?? "GET";
  const requestPath = normalizeApiPath(path);
  const url = joinApiUrl(API_BASE_URL, requestPath);

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
    { path: requestPath, method, operation },
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
      { path: requestPath, method, operation }
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

async function apiFetchBlob(path: string, token: string, operation = "library.preview"): Promise<Blob> {
  const requestPath = normalizeApiPath(path);
  const url = joinApiUrl(API_BASE_URL, requestPath);
  const response = await fetchWithNetworkMessage(
    url,
    { credentials: "include", headers: { Authorization: `Bearer ${token}` } },
    { path: requestPath, method: "GET", operation },
    DEFAULT_API_TIMEOUT_MS
  );
  if (!response.ok) {
    throw createHttpError(response.status, response.statusText, await readErrorPayload(response), url, response.headers.get("x-request-id"));
  }
  return response.blob();
}

export const api = {
  health: () => apiFetch<ApiHealth>("/health", {
    operation: "system.health",
    timeoutMs: 5000
  }),
  demoChatConfig: () => apiFetch<DemoChatConfig>("/demo/chat/config", { operation: "demo.chat.config" }),
  demoChat: (
    payload: { session_id: string; message: string; mode: "chat" | "research" | "vision" },
    signal?: AbortSignal
  ) =>
    apiFetch<DemoChatResult>("/demo/chat", {
      method: "POST",
      operation: "demo.chat",
      timeoutMs: 45000,
      credentials: "omit",
      signal,
      body: JSON.stringify(payload)
    }),
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
      timeoutMs: 20000,
      body: JSON.stringify(payload)
    }),
  agentLogin: (payload: { agent_id: string; password: string }) =>
    apiFetch<AuthSession & { agent: { must_change_password: boolean } }>("/form-services/seva-operations/agent/login", {
      method: "POST",
      operation: "seva.agent.login",
      timeoutMs: 20000,
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
      operation: "auth.google.config",
      timeoutMs: 5000
    }),
  googleLogin: (payload: { id_token: string }) =>
    apiFetch<AuthSession>("/auth/google", {
      method: "POST",
      operation: "auth.google",
      timeoutMs: 20000,
      body: JSON.stringify(payload)
    }),
  refreshSession: (refreshToken?: string | null) =>
    apiFetch<AuthSession>("/auth/refresh", {
      method: "POST",
      operation: "auth.refresh",
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined,
      timeoutMs: 8000
    }),
  logout: (token?: string | null, refreshToken?: string | null) =>
    apiFetch<void>("/auth/logout", {
      method: "POST",
      token,
      operation: "auth.logout",
      body: refreshToken ? JSON.stringify({ refresh_token: refreshToken }) : undefined
    }),
  me: (token: string) => apiFetch<User>("/auth/me", { token, operation: "auth.me", timeoutMs: 6000 }),
  profile: (token: string) => apiFetch<User>("/users/me", { token, operation: "users.me" }),
  updateProfile: (token: string, payload: Partial<Pick<User, "name" | "username" | "phone_number" | "phone_country_code" | "memory_enabled" | "feedback_learning_enabled">>) =>
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
  createChat: (token: string, payload: {
    title?: string;
    system_prompt?: string;
    model?: string;
    mode?: ChatRequest["mode"];
    presetMode?: ChatRequest["presetMode"];
    selectedPreset?: ChatRequest["selectedPreset"];
    manualPresetLocked?: boolean;
  }) =>
    apiFetch<Chat>("/chat/sessions", { method: "POST", token, operation: "chat.sessions.create", body: JSON.stringify(payload) }),
  getChat: (token: string, id: string) => apiFetch<Chat>(`/chat/sessions/${id}`, { token, operation: "chat.sessions.get" }),
  updateChat: (token: string, id: string, payload: {
    title?: string;
    system_prompt?: string;
    model?: string;
    mode?: ChatRequest["mode"];
    presetMode?: ChatRequest["presetMode"];
    selectedPreset?: ChatRequest["selectedPreset"];
    manualPresetLocked?: boolean;
    clear_messages?: boolean;
  }) =>
    apiFetch<Chat>(`/chat/sessions/${id}`, { method: "PATCH", token, operation: "chat.sessions.update", body: JSON.stringify(payload) }),
  deleteChat: (token: string, id: string) => apiFetch<void>(`/chat/sessions/${id}`, { method: "DELETE", token, operation: "chat.sessions.delete" }),
  exportChatBackup: (token: string) => apiFetchBlob("/user-data/backup", token, "userData.backup.export"),
  previewChatRestore: (token: string, backup: ChatBackup) => apiFetch<BackupPreview>("/user-data/restore/preview", { method: "POST", token, operation: "userData.backup.preview", body: JSON.stringify(backup), timeoutMs: 30000 }),
  restoreChatBackup: (token: string, backup: ChatBackup, mode: "merge" | "replace", confirmReplace: boolean) => apiFetch<RestoreResult>("/user-data/restore", { method: "POST", token, operation: "userData.backup.restore", body: JSON.stringify({ backup, mode, confirm_replace: confirmReplace }), timeoutMs: 120000 }),
  userUsage: (token: string, days: number, range?: { start: string; end: string }) => {
    const params = new URLSearchParams({ days: String(days) });
    if (range) {
      params.set("start", `${range.start}T00:00:00Z`);
      params.set("end", `${range.end}T23:59:59.999Z`);
    }
    return apiFetch<UserUsage>(`/user-data/usage?${params}`, { token, operation: "userData.usage" });
  },
  notificationPreferences: (token: string) => apiFetch<{ enabled: boolean; apk_updates: boolean; seva_updates: boolean; payment_updates: boolean; social_updates: boolean }>("/notifications/preferences", { token, operation: "notifications.preferences" }),
  updateNotificationPreferences: (token: string, payload: { enabled?: boolean; apk_updates?: boolean; seva_updates?: boolean; payment_updates?: boolean; social_updates?: boolean }) => apiFetch<{ enabled: boolean }>("/notifications/preferences", { method: "PATCH", token, operation: "notifications.preferences.update", body: JSON.stringify(payload) }),

  listDocuments: (token: string) => apiFetch<DocumentItem[]>("/documents", { token, operation: "documents.list" }),
  listLibraryAssets: (token: string, options: { query?: string; fileType?: string; sort?: string; page?: number } = {}) => {
    const params = new URLSearchParams({
      page: String(options.page || 1),
      page_size: "48",
      sort: options.sort || "newest"
    });
    if (options.query?.trim()) params.set("query", options.query.trim());
    if (options.fileType) params.set("file_type", options.fileType);
    return apiFetch<LibraryAssetPage>(`/library/assets?${params}`, { token, operation: "library.list" });
  },
  uploadLibraryAsset: (token: string, file: File, source: LibraryAsset["source"] = "upload") => {
    const form = new FormData();
    form.append("file", file);
    form.append("source", source);
    return apiFetch<LibraryAsset>("/library/assets", { method: "POST", token, operation: "library.upload", body: form, timeoutMs: 300000 });
  },
  renameLibraryAsset: (token: string, id: string, displayName: string) =>
    apiFetch<LibraryAsset>(`/library/assets/${id}`, { method: "PATCH", token, operation: "library.rename", body: JSON.stringify({ display_name: displayName }) }),
  deleteLibraryAsset: (token: string, id: string) =>
    apiFetch<void>(`/library/assets/${id}`, { method: "DELETE", token, operation: "library.delete" }),
  attachLibraryAsset: (token: string, id: string, chatId?: string) =>
    apiFetch<LibraryAttachment>(`/library/assets/${id}/attach`, { method: "POST", token, operation: "library.attach", body: JSON.stringify({ chat_id: chatId || null }) }),
  previewLibraryAsset: (token: string, id: string) => apiFetchBlob(`/library/assets/${id}/preview`, token),
  uploadDocument: (token: string, formData: FormData) =>
    apiFetch<DocumentItem>("/documents/upload", { method: "POST", token, operation: "documents.upload", body: formData, timeoutMs: 300000 }),
  uploadDocumentWithProgress: (
    token: string,
    formData: FormData,
    onProgress: (progress: number) => void
  ) =>
    new Promise<DocumentItem>((resolve, reject) => {
      const url = joinApiUrl(API_BASE_URL, "/documents/upload");
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
  clearMemories: (token: string) =>
    apiFetch<void>("/human/memories", { method: "DELETE", token, operation: "human.memories.clear" }),
  getMessageFeedback: (token: string, chatId: string, messageId: string) =>
    apiFetch<MessageFeedback | null>(`/chat/sessions/${chatId}/messages/${messageId}/feedback`, {
      token,
      operation: "chat.feedback.get"
    }),
  putMessageFeedback: (
    token: string,
    chatId: string,
    messageId: string,
    payload: { rating: 1 | -1; reason?: MessageFeedbackReason | null; comment?: string | null }
  ) =>
    apiFetch<MessageFeedback>(`/chat/sessions/${chatId}/messages/${messageId}/feedback`, {
      method: "PUT",
      token,
      operation: "chat.feedback.put",
      body: JSON.stringify(payload)
    }),
  deleteMessageFeedback: (token: string, chatId: string, messageId: string) =>
    apiFetch<void>(`/chat/sessions/${chatId}/messages/${messageId}/feedback`, {
      method: "DELETE",
      token,
      operation: "chat.feedback.delete"
    }),
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
  runAssistantCommand: (token: string, payload: { message: string; timezone: string; request_id: string; context: Array<{ role: string; content: string }>; platform: "web" | "android" | "ios" }) =>
    apiFetch<AssistantResponse>("/assistant/command", { method: "POST", token, operation: "assistant.command", body: JSON.stringify(payload), timeoutMs: 45000 }),
  confirmAssistantAction: (token: string, actionId: string) =>
    apiFetch<AssistantActionItem>(`/assistant/actions/${actionId}/confirm`, { method: "POST", token, operation: "assistant.action.confirm" }),
  cancelAssistantAction: (token: string, actionId: string) =>
    apiFetch<AssistantActionItem>(`/assistant/actions/${actionId}/cancel`, { method: "POST", token, operation: "assistant.action.cancel" }),
  clearAssistantHistory: (token: string) =>
    apiFetch<void>("/assistant/history", { method: "DELETE", token, operation: "assistant.history.clear" }),

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
  paymentPlans: () => apiFetch<BillingPlan[]>("/payments/plans", { operation: "payments.plans" }),
  billingCenter: (token: string) => apiFetch<BillingCenter>("/payments/billing", { token, operation: "payments.billing" }),
  paymentHistory: (token: string, options: { query?: string; status?: "all" | "success" | "failed"; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams({
      query: options.query?.trim() || "",
      status: options.status || "all",
      page: String(options.page || 1),
      page_size: String(options.pageSize || 20)
    });
    return apiFetch<PaymentHistoryPage>(`/payments/history?${params}`, { token, operation: "payments.history" });
  },
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
  cancelPaymentSession: (token: string, sessionId: string) =>
    apiFetch<void>(`/payments/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
      token,
      operation: "payments.cancelSession"
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
  intelligenceConfig: (token: string) => apiFetch<IntelligenceConfig>("/ai/intelligence/config", { token, operation: "ai.intelligenceConfig" }),
  startChatGeneration: (token: string, payload: ChatRequest, signal?: AbortSignal) =>
    apiFetch<ChatGeneration>(payload.chat_id ? `/chat/sessions/${payload.chat_id}/messages` : "/ai/chat/generations", {
      method: "POST",
      token,
      operation: payload.chat_id ? "chat.sessions.messages.create" : "ai.chat.generations.start",
      body: JSON.stringify(payload),
      signal,
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
      operation: "ai.chat.generations.active",
      timeoutMs: 5000
    }),
  getChatGeneration: (token: string, generationId: string) =>
    apiFetch<ChatGeneration>(`/ai/chat/generations/${generationId}`, {
      token,
      operation: "ai.chat.generations.get",
      timeoutMs: 5000
    }),
  cancelChatGeneration: (token: string, generationId: string) =>
    apiFetch<ChatGeneration>(`/ai/chat/generations/${generationId}/cancel`, {
      method: "POST",
      token,
      operation: "ai.chat.generations.cancel"
    }),

  adminStats: (token: string) => apiFetch<AdminStats>("/admin/stats", { token, operation: "admin.stats" }),
  adminSystemStatus: (token: string) => apiFetch<AdminSystemStatus>("/admin/system-status", { token, operation: "admin.system_status" }),
  adminAuditLogs: (token: string, page = 1, search = "") => {
    const params = new URLSearchParams({ page: String(page), page_size: "50" });
    if (search.trim()) params.set("search", search.trim());
    return apiFetch<AdminAuditLogPage>(`/admin/audit-logs?${params}`, { token, operation: "admin.audit_logs" });
  },
  adminUsers: (token: string, params: { search?: string; role?: string; status?: string; page?: number; pageSize?: number; sortBy?: "created_at" | "name" | "email" | "role"; sortOrder?: "asc" | "desc" } = {}) => {
    const search = new URLSearchParams();
    if (params.search) search.set("search", params.search);
    if (params.role) search.set("role", params.role);
    if (params.status) search.set("status", params.status);
    if (params.page) search.set("page", String(params.page));
    if (params.pageSize) search.set("page_size", String(params.pageSize));
    if (params.sortBy) search.set("sort_by", params.sortBy);
    if (params.sortOrder) search.set("sort_order", params.sortOrder);
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
  createAdminUser: (token: string, payload: { name: string; email: string; password: string; role: Exclude<UserRole, "user"> }) =>
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
  adminSubscriptions: (token: string, options: { search?: string; plan?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.search) params.set("search", options.search);
    if (options.plan) params.set("plan", options.plan);
    if (options.status) params.set("status", options.status);
    if (options.page) params.set("page", String(options.page));
    if (options.pageSize) params.set("page_size", String(options.pageSize));
    const suffix = params.size ? `?${params}` : "";
    return apiFetch<AdminSubscription[]>(`/admin/subscriptions${suffix}`, { token, operation: "admin.subscriptions.list" });
  },
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
  adminPayments: (
    token: string,
    options: { query?: string; status?: "all" | "success" | "failed"; page?: number; pageSize?: number; dateFrom?: string; dateTo?: string } = {}
  ) => {
    const params = new URLSearchParams({
      query: options.query?.trim() || "",
      status: options.status || "all",
      page: String(options.page || 1),
      page_size: String(options.pageSize || 20)
    });
    if (options.dateFrom) params.set("date_from", options.dateFrom);
    if (options.dateTo) params.set("date_to", options.dateTo);
    return apiFetch<AdminPaymentPage>(`/admin/subscriptions/payments?${params}`, { token, operation: "admin.payments" });
  },
  adminPromoCodes: (token: string, options: { query?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const params = new URLSearchParams({
      query: options.query?.trim() || "",
      status: options.status || "all",
      page: String(options.page || 1),
      page_size: String(options.pageSize || 20)
    });
    return apiFetch<PromoCodePage>(`/admin/promo-codes?${params}`, { token, operation: "admin.promos.list" });
  },
  adminCreatePromoCode: (token: string, payload: PromoCodePayload) =>
    apiFetch<PromoCode>("/admin/promo-codes", {
      method: "POST",
      token,
      operation: "admin.promos.create",
      body: JSON.stringify(payload)
    }),
  adminUpdatePromoCode: (token: string, promoId: string, payload: Partial<Omit<PromoCodePayload, "code">>) =>
    apiFetch<PromoCode>(`/admin/promo-codes/${encodeURIComponent(promoId)}`, {
      method: "PATCH",
      token,
      operation: "admin.promos.update",
      body: JSON.stringify(payload)
    }),
  adminArchivePromoCode: (token: string, promoId: string, archived = true) =>
    apiFetch<PromoCode>(`/admin/promo-codes/${encodeURIComponent(promoId)}/archive`, {
      method: "PATCH",
      token,
      operation: "admin.promos.archive",
      body: JSON.stringify({ archived })
    }),
  createStripeCheckoutSession: (token: string, payload: { plan_id: PaidPricingPlanName; currency?: string; receipt?: string; promo_code?: string | null }) =>
    apiFetch<StripeCheckoutSession>("/payments/stripe/create-session", { method: "POST", token, operation: "payments.stripe.createSession", body: JSON.stringify(payload), timeoutMs: 30000 }),
  interpretServiceRequest: (token: string, payload: { message: string; chat_id?: string | null; timezone: string; locale: string; client_request_id: string }) =>
    apiFetch<ServiceIntentResponse>("/form-services/interpret", { method: "POST", token, operation: "formService.interpret", body: JSON.stringify(payload) }),
  getServiceTask: (token: string, taskId: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}`, { token, operation: "formService.task.get" }),
  startServiceTask: (token: string, taskId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/start`, { method: "POST", token, operation: "formService.task.start", body: JSON.stringify({ version, request_id: crypto.randomUUID(), reason: "User started the application" }) }),
  saveServiceFields: (token: string, taskId: string, version: number, dataRequestId: string, values: Record<string, unknown>) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/fields`, { method: "POST", token, operation: "formService.fields.save", body: JSON.stringify({ version, request_id: crypto.randomUUID(), data_request_id: dataRequestId, values }) }),
  prepareServiceTask: (token: string, taskId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/prepare`, { method: "POST", token, operation: "formService.task.prepare", body: JSON.stringify({ version, request_id: crypto.randomUUID(), reason: "User requested draft preparation" }) }),
  approveServiceReview: (token: string, taskId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/approve-review`, { method: "POST", token, operation: "formService.review.approve", body: JSON.stringify({ version, request_id: crypto.randomUUID(), reason: "User approved reviewed information" }) }),
  confirmServiceSubmission: (token: string, taskId: string, version: number, deviceConfirmation: "not_required" | "confirmed" | "unavailable" = "not_required") =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/confirmation`, { method: "POST", token, operation: "formService.submission.confirm", body: JSON.stringify({ version, request_id: crypto.randomUUID(), declaration_accepted: true, device_confirmation: deviceConfirmation }) }),
  submitServiceTask: (token: string, taskId: string, version: number, confirmationId: string, idempotencyKey: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/submit`, { method: "POST", token, operation: "formService.submission.execute", body: JSON.stringify({ version, request_id: crypto.randomUUID(), confirmation_id: confirmationId, idempotency_key: idempotencyKey }) }),
  serviceTaskAction: (token: string, taskId: string, action: "pause" | "resume" | "cancel" | "retry" | "review-again" | "edit" | "edit-documents", version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST", token, operation: `formService.task.${action}`, body: JSON.stringify({ version, request_id: crypto.randomUUID(), reason: `User requested ${action}` }) }),
  createServicePortalSession: (token: string, taskId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/portal-session`, { method: "POST", token, operation: "formService.portal.open", body: JSON.stringify({ version, request_id: crypto.randomUUID(), take_control: true }) }),
  completeServiceHumanAction: (token: string, taskId: string, version: number, action: "otp" | "password" | "captcha" | "biometric" | "digital_signature" | "payment" | "consent_declaration" | "physical_verification") =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/human-action`, { method: "POST", token, operation: "formService.humanAction", body: JSON.stringify({ version, request_id: crypto.randomUUID(), action, completed: true }) }),
  reportServicePortalOutcome: (token: string, taskId: string, version: number, outcome: "submitted" | "rejected" | "not_submitted" | "unknown", applicationId?: string, transactionId?: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/portal-outcome`, { method: "POST", token, operation: "formService.portal.outcome", body: JSON.stringify({ version, request_id: crypto.randomUUID(), user_reported_status: outcome, application_id: applicationId || null, transaction_id: transactionId || null, idempotency_key: crypto.randomUUID() }) }),
  requestServiceHandoff: (token: string, taskId: string, version: number, approvedFieldKeys: string[], approvedDocumentIds: string[], purpose: string) =>
    apiFetch<Record<string, unknown>>(`/form-services/tasks/${encodeURIComponent(taskId)}/handoff`, { method: "POST", token, operation: "formService.handoff", body: JSON.stringify({ version, request_id: crypto.randomUUID(), approved_field_keys: approvedFieldKeys, approved_document_ids: approvedDocumentIds, purpose }) }),
  revokeServiceHandoff: (token: string, taskId: string, handoffId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/handoff/${encodeURIComponent(handoffId)}/revoke`, { method: "POST", token, operation: "formService.handoff.revoke", body: JSON.stringify({ version, request_id: crypto.randomUUID(), reason: "User revoked the human assistance handoff" }) }),
  requestServicePermission: (token: string, taskId: string, version: number, capability: "camera" | "document_picker") =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/permissions`, { method: "POST", token, operation: "formService.permission.request", body: JSON.stringify({ version, request_id: crypto.randomUUID(), capability }) }),
  resolveServicePermission: (token: string, taskId: string, permissionId: string, version: number, nativeStatus: "GRANTED" | "DENIED" | "PERMANENTLY_DENIED" | "UNAVAILABLE" | "NOT_REQUIRED") =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/permissions/${encodeURIComponent(permissionId)}/resolve`, { method: "POST", token, operation: "formService.permission.resolve", body: JSON.stringify({ version, request_id: crypto.randomUUID(), native_status: nativeStatus }) }),
  createServiceSecureChallenge: (token: string, taskId: string, version: number, kind: "otp" | "password" | "recovery_code" | "authentication_token") =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/secure-challenges`, { method: "POST", token, operation: "formService.secure.create", body: JSON.stringify({ version, request_id: crypto.randomUUID(), kind }) }),
  submitServiceSecureResponse: (token: string, taskId: string, challengeId: string, secret: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/secure-challenges/${encodeURIComponent(challengeId)}/response`, { method: "POST", token, operation: "formService.secure.submit", body: JSON.stringify({ request_id: crypto.randomUUID(), secret }) }),
  trackServiceTask: (token: string, taskId: string) =>
    apiFetch<Record<string, unknown>>(`/form-services/tasks/${encodeURIComponent(taskId)}/track?request_id=${encodeURIComponent(crypto.randomUUID())}`, { method: "POST", token, operation: "formService.track" }),
  uploadServiceDocument: (token: string, taskId: string, version: number, requirementId: string, file: File, saveToVault: boolean, onProgress: (value: number) => void) =>
    new Promise<ServiceTaskView>((resolve, reject) => {
      const path = `/form-services/tasks/${encodeURIComponent(taskId)}/documents`;
      const url = joinApiUrl(API_BASE_URL, path);
      const form = new FormData();
      form.append("requirement_id", requirementId);
      form.append("version", String(version));
      form.append("request_id", crypto.randomUUID());
      form.append("save_to_vault", String(saveToVault));
      form.append("file", file);
      const request = new XMLHttpRequest();
      request.open("POST", url);
      request.timeout = 5 * 60 * 1000;
      request.setRequestHeader("Authorization", `Bearer ${token}`);
      request.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round(event.loaded / event.total * 100));
      request.onload = () => {
        let payload: unknown = undefined;
        try { payload = request.responseText ? JSON.parse(request.responseText) : undefined; } catch { payload = { detail: request.statusText }; }
        if (request.status >= 200 && request.status < 300) resolve(payload as ServiceTaskView);
        else reject(new ApiClientError(getErrorMessage(payload, `Upload failed (${request.status})`), { kind: request.status === 401 ? "authentication_failed" : "http_error", status: request.status, url, details: payload }));
      };
      request.onerror = () => reject(new ApiClientError("Document upload could not reach AutoAI.", { kind: "network_unavailable", url }));
      request.ontimeout = () => reject(new ApiClientError("Document upload timed out. Retry is safe.", { kind: "server_unreachable", url }));
      request.send(form);
    }),
  attachServiceVaultDocument: (token: string, taskId: string, version: number, requirementId: string, libraryAssetId: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/documents/from-vault`, { method: "POST", token, operation: "formService.document.vault", body: JSON.stringify({ version, request_id: crypto.randomUUID(), requirement_id: requirementId, library_asset_id: libraryAssetId }) }),
  decideServiceDocumentAnalysis: (token: string, taskId: string, version: number, assetId: string, accepted: boolean, acceptedFields: string[]) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(assetId)}/analysis`, { method: "POST", token, operation: "formService.document.analysis", body: JSON.stringify({ version, request_id: crypto.randomUUID(), accepted, accepted_fields: acceptedFields }) }),
  runServiceDocumentOcr: (token: string, taskId: string, version: number, assetId: string) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(assetId)}/ocr`, { method: "POST", token, operation: "formService.document.ocr", body: JSON.stringify({ version, request_id: crypto.randomUUID(), cloud_processing_accepted: true }) }),
  previewServiceDocument: (token: string, signedPath: string) => apiFetchBlob(signedPath, token),
  removeServiceDocument: (token: string, taskId: string, assetId: string, version: number) =>
    apiFetch<ServiceTaskView>(`/form-services/tasks/${encodeURIComponent(taskId)}/documents/${encodeURIComponent(assetId)}?version=${version}&request_id=${encodeURIComponent(crypto.randomUUID())}`, { method: "DELETE", token, operation: "formService.document.remove" }),
  interpretIntent: (token: string, payload: { message: string; chat_id?: string | null; timezone: string; locale: string; platform: "web" | "android" | "ios"; device_capabilities: string[]; granted_permissions: string[]; client_request_id: string }) =>
    apiFetch<IntentEngineResponse>("/intent-engine/interpret", { method: "POST", token, operation: "intent.interpret", body: JSON.stringify(payload) }),
  submitIntentInteraction: (token: string, workflowId: string, payload: { values: Record<string, unknown>; decision: "submit" | "confirm" | "cancel" | "retry" | "pause" }) =>
    apiFetch<{ workflow_id: string; state: string }>(`/intent-engine/workflows/${encodeURIComponent(workflowId)}/interaction`, { method: "POST", token, operation: "intent.interaction", body: JSON.stringify(payload) }),
  createSecureChallenge: (token: string, workflowId: string, kind: "otp" | "password" | "oauth" | "passkey") =>
    apiFetch<{ id: string; status: string }>("/intent-engine/secure-challenges", { method: "POST", token, operation: "intent.secure.create", body: JSON.stringify({ workflow_id: workflowId, kind, destination: workflowId, expires_in_seconds: 300 }) }),
  submitSecureChallenge: (token: string, challengeId: string, secret: string) =>
    apiFetch<{ id: string; status: string; workflow_id: string }>(`/intent-engine/secure-challenges/${encodeURIComponent(challengeId)}/submit`, { method: "POST", token, operation: "intent.secure.submit", body: JSON.stringify({ secret }) })
};

export async function streamChat(
  token: string,
  payload: ChatRequest,
  onEvent: (event: StreamEvent) => void
) {
  const path = "/ai/chat/stream";
  const url = joinApiUrl(API_BASE_URL, path);
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

export async function streamGenerationActivity(
  token: string,
  generationId: string,
  onEvent: (event: OrchestrationActivityEvent) => void,
  options: { after?: number; signal?: AbortSignal } = {}
) {
  const path = `/ai/chat/generations/${encodeURIComponent(generationId)}/events?after=${Math.max(0, options.after ?? 0)}`;
  const response = await fetchWithNetworkMessage(
    joinApiUrl(API_BASE_URL, path),
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: options.signal
    },
    { path, method: "GET", operation: "ai.chat.generations.events" }
  );
  if (!response.ok || !response.body) {
    const errorPayload = await readErrorPayload(response);
    throw createHttpError(
      response.status,
      response.statusText,
      errorPayload,
      response.url,
      response.headers.get("x-request-id"),
      { path, method: "GET", operation: "ai.chat.generations.events" }
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace(/^data:\s*/, "");
      if (!data) continue;
      const parsed = JSON.parse(data) as OrchestrationActivityEvent;
      if (parsed.event && parsed.request_id) onEvent(parsed);
    }
  }
}

export type ServiceTaskEvent = {
  id: string;
  workflow_id: string;
  event_type: string;
  details: Record<string, unknown>;
  request_id: string;
  created_at: string;
};

export async function streamServiceTaskEvents(
  token: string,
  taskId: string,
  onEvent: (event: ServiceTaskEvent) => void,
  options: { after?: string; signal?: AbortSignal } = {}
) {
  const query = options.after ? `?after=${encodeURIComponent(options.after)}` : "";
  const path = `/form-services/tasks/${encodeURIComponent(taskId)}/events${query}`;
  const response = await fetchWithNetworkMessage(
    joinApiUrl(API_BASE_URL, path),
    {
      headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
      signal: options.signal
    },
    { path, method: "GET", operation: "formService.task.events" }
  );
  if (!response.ok || !response.body) {
    const errorPayload = await readErrorPayload(response);
    throw createHttpError(
      response.status,
      response.statusText,
      errorPayload,
      response.url,
      response.headers.get("x-request-id"),
      { path, method: "GET", operation: "formService.task.events" }
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace(/^data:\s*/, "");
      if (!data) continue;
      const parsed = JSON.parse(data) as Partial<ServiceTaskEvent>;
      if (parsed.id && parsed.workflow_id === taskId && parsed.event_type && parsed.details && parsed.request_id && parsed.created_at) {
        onEvent(parsed as ServiceTaskEvent);
      }
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
