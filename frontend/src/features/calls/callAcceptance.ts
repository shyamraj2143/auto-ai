import type { CallRecord } from "./types";

const ACCEPTABLE_STATUSES = new Set(["initiated", "ringing", "accepted", "connecting", "active"]);
const ALREADY_ACCEPTED_STATUSES = new Set(["accepted", "connecting", "active"]);

export function canResumeAcceptedCall(call: Pick<CallRecord, "status">) {
  return ACCEPTABLE_STATUSES.has(call.status);
}

export function requiresAcceptRequest(call: Pick<CallRecord, "status">) {
  return !ALREADY_ACCEPTED_STATUSES.has(call.status);
}
