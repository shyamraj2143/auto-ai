import type { CallSessionState } from "./types";

export type CallStatusSemantic = "success" | "processing" | "recovery" | "error" | "neutral";

const LABELS: Record<CallSessionState, string> = {
  idle: "Idle",
  preparing: "Preparing...",
  dialing: "Calling...",
  notifying: "Notifying...",
  ringing: "Ringing...",
  incoming: "Incoming call",
  accepting: "Accepting...",
  connecting: "Connecting audio and video...",
  active: "Connected — Audio and video are working",
  reconnecting: "Network interrupted — Reconnecting...",
  ending: "Ending call...",
  ended: "Call ended",
  rejected: "Call declined",
  cancelled: "Call cancelled",
  missed: "No answer",
  busy: "User is on another call",
  failed: "Call failed",
};

export function callStatusPresentation(state: CallSessionState): { label: string; semantic: CallStatusSemantic; color: string } {
  if (state === "active") return { label: LABELS[state], semantic: "success", color: "#22C55E" };
  if (["preparing", "dialing", "notifying", "ringing", "incoming", "accepting", "connecting", "ending"].includes(state)) {
    return { label: LABELS[state], semantic: "processing", color: "#22D3EE" };
  }
  if (state === "reconnecting") return { label: LABELS[state], semantic: "recovery", color: "#F59E0B" };
  if (state === "failed") return { label: LABELS[state], semantic: "error", color: "#EF4444" };
  return { label: LABELS[state], semantic: "neutral", color: "#94A3B8" };
}
