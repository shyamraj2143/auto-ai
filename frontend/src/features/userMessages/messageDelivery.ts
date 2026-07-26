import { ApiClientError } from "../../api/client";
import type { UserMessage } from "./types";

export function messageSendError(error: unknown) {
  if (!(error instanceof ApiClientError)) return error instanceof Error ? error.message : "Message could not be sent. Tap to retry.";
  if (error.status === 401) return "Your session expired. Sign in again to send messages.";
  if (error.status === 403) return "Messaging permission was removed for this conversation.";
  if (error.status === 404) return "This user or conversation is no longer available.";
  if (error.status === 429) return "Too many messages. Please wait a moment and retry.";
  if (error.status && error.status >= 500) return "Messaging is temporarily unavailable. Tap to retry.";
  if (["network_unavailable", "server_unreachable", "cors_blocked", "ssl_certificate_issue"].includes(error.kind)) {
    return "Connection lost before the message was saved. Tap to retry.";
  }
  return error.message || "Message could not be sent. Tap to retry.";
}

export function replaceOptimisticMessage(messages: UserMessage[], clientMessageId: string, saved: UserMessage) {
  return messages.map((message) => message.client_message_id === clientMessageId ? saved : message);
}

export function failOptimisticMessage(messages: UserMessage[], clientMessageId: string) {
  return messages.map((message) => message.client_message_id === clientMessageId ? { ...message, status: "failed" as const } : message);
}
