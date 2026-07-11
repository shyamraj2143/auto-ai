import { ApiClientError } from "../api/client";

export function loginErrorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Email or password is incorrect.";
    if (error.status === 404) return "Login service is temporarily unavailable.";
    if (error.status === 422) return "Login request format is invalid.";
    if (error.status && error.status >= 500) return "Server error. Please try again.";
    if (["network_unavailable", "server_unreachable", "cors_blocked", "ssl_certificate_issue"].includes(error.kind)) {
      return "Auto-AI server is unreachable.";
    }
  }
  return authErrorMessage(error, "Unable to log in");
}

export function authErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    const detail = error.details && typeof error.details === "object" && "detail" in error.details
      ? (error.details as { detail?: unknown }).detail
      : null;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
