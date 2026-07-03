import { ApiClientError } from "../api/client";

export function authErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiClientError) {
    const detail = error.details && typeof error.details === "object" && "detail" in error.details
      ? (error.details as { detail?: unknown }).detail
      : null;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
