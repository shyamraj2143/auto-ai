import type { QuickConnectAction } from "./QuickConnect";

export function validateQuickConnect(action: QuickConnectAction, rawValue: string) {
  const trimmed = rawValue.trim();
  if (action === "screen") {
    const value = trimmed.replace(/\D/g, "").slice(0, 8);
    return value.length === 8
      ? { valid: true as const, value }
      : { valid: false as const, value, error: "Enter a valid 8 digit sharing code." };
  }
  if (action === "ai") {
    return trimmed
      ? { valid: true as const, value: trimmed.slice(0, 2000) }
      : { valid: false as const, value: "", error: "Enter an AI command." };
  }
  const value = trimmed.slice(0, 80);
  return value.length >= 2
    ? { valid: true as const, value }
    : { valid: false as const, value, error: "Enter at least 2 characters to find a contact." };
}

export function callSearchRoute(query: string, type: "audio" | "video") {
  const params = new URLSearchParams({ view: "search", type, q: query });
  return `/calls?${params.toString()}`;
}

export function isActiveScreenShareState(state: string) {
  return !["idle", "ended", "failed"].includes(state);
}
