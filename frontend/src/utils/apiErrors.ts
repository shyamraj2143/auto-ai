import { ApiClientError } from "../api/client";

export function loginErrorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401) return "Email or password is incorrect.";
    if (error.status === 404) return "Login service is temporarily unavailable.";
    if (error.status === 422) return "Login request format is invalid.";
    if (error.status && error.status >= 500) return "Auto-AI server error. Please try again.";
    if (error.kind === "network_unavailable") {
      return "Internet connection is unavailable. Check mobile data or Wi-Fi and try again.";
    }
    if (error.kind === "cors_blocked") {
      return "Auto-AI server is reachable, but the app connection is blocked. Please retry.";
    }
    if (error.kind === "ssl_certificate_issue") {
      return "Auto-AI server security connection failed. Please retry in a moment.";
    }
    if (error.kind === "server_unreachable") {
      return "Auto-AI server is not responding right now. Your internet is available; please retry shortly.";
    }
  }
  return authErrorMessage(error, "Unable to log in");
}

export function registerErrorMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 404) return "Registration service is temporarily unavailable.";
    if (error.status === 409) return "An account with this email already exists.";
    if (error.status === 422) return "Please check the registration details.";
    if (error.status && error.status >= 500) return "Server error. Please try again.";
    if (["network_unavailable", "server_unreachable", "cors_blocked", "ssl_certificate_issue"].includes(error.kind)) {
      return error.kind === "network_unavailable"
        ? "You are offline. Check mobile data or Wi-Fi and try again."
        : "Registration timed out. Check your connection and try again.";
    }
  }
  return authErrorMessage(error, "Unable to register");
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