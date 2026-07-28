import type { CallRecord } from "./types";

const ACCEPTABLE_STATUSES = new Set(["initiated", "ringing", "accepted", "connecting", "active"]);
const ALREADY_ACCEPTED_STATUSES = new Set(["accepted", "connecting", "active"]);
const RINGING_STATUSES = new Set(["initiated", "ringing"]);
const TERMINAL_STATUSES = new Set(["rejected", "cancelled", "missed", "failed", "ended"]);

export function canResumeAcceptedCall(call: Pick<CallRecord, "status">) {
  return ACCEPTABLE_STATUSES.has(call.status);
}

export function requiresAcceptRequest(call: Pick<CallRecord, "status">) {
  return !ALREADY_ACCEPTED_STATUSES.has(call.status);
}

export function nativeCallRestoreMode(status: string, action?: string | null): "ringing" | "resume" | "terminal" {
  if (ALREADY_ACCEPTED_STATUSES.has(status)) return "resume";
  if (RINGING_STATUSES.has(status)) return "ringing";
  if (TERMINAL_STATUSES.has(status) || action === "resume_call") return "terminal";
  return "terminal";
}
