import type { ChatAttachment, ChatGeneration, Message } from "../../types";

export type ChatRequestState =
  | "idle"
  | "saving_user_message"
  | "connecting"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export type ActiveChatRequest = {
  requestId: string;
  assistantId: string;
  chatId?: string;
  clientMessageId: string;
};

export function clientMessageIdOf(message?: Message | null) {
  return typeof message?.message_metadata?.client_message_id === "string"
    ? message.message_metadata.client_message_id
    : "";
}

export function isRequestBusy(state: ChatRequestState) {
  return state === "saving_user_message" || state === "connecting" || state === "streaming";
}

export function attachmentsOf(message?: Message | null): ChatAttachment[] {
  return Array.isArray(message?.message_metadata?.attachments)
    ? message.message_metadata.attachments
    : [];
}

export function mergeAttachmentPreviews(incoming: ChatAttachment[], existing: ChatAttachment[]) {
  return incoming.map((attachment) => {
    const previous = existing.find((item) => item.id === attachment.id || item.filename === attachment.filename);
    return previous?.preview_url && !attachment.preview_url
      ? { ...attachment, preview_url: previous.preview_url }
      : attachment;
  });
}

export function upsertChatMessage(current: Message[], incoming: Message) {
  const incomingClientId = clientMessageIdOf(incoming);
  const index = current.findIndex((message) =>
    message.id === incoming.id ||
    (incomingClientId && message.role === incoming.role && clientMessageIdOf(message) === incomingClientId)
  );
  if (index < 0) return [...current, incoming];
  const existing = current[index];
  if (existing === incoming) return current;
  const incomingAttachments = attachmentsOf(incoming);
  const next = current.slice();
  next[index] = incomingAttachments.length
    ? {
        ...incoming,
        message_metadata: {
          ...(incoming.message_metadata || {}),
          attachments: mergeAttachmentPreviews(incomingAttachments, attachmentsOf(existing))
        }
      }
    : incoming;
  return next;
}

export function mergeChatMessages(serverMessages: Message[], localMessages: Message[]) {
  const next = serverMessages.slice();
  for (const localMessage of localMessages) {
    const localClientId = clientMessageIdOf(localMessage);
    const index = next.findIndex((serverMessage) =>
      serverMessage.id === localMessage.id ||
      (localClientId && serverMessage.role === localMessage.role && clientMessageIdOf(serverMessage) === localClientId)
    );
    if (index < 0) {
      next.push(localMessage);
      continue;
    }
    const serverMessage = next[index];
    const serverAttachments = attachmentsOf(serverMessage);
    if (serverAttachments.length) {
      next[index] = {
        ...serverMessage,
        message_metadata: {
          ...(serverMessage.message_metadata || {}),
          attachments: mergeAttachmentPreviews(serverAttachments, attachmentsOf(localMessage))
        }
      };
    }
  }
  return next;
}

export function appendOptimisticMessages(current: Message[], pendingMessages: Message[]) {
  return pendingMessages.reduce(upsertChatMessage, current);
}

export function generationClientMessageId(generation: ChatGeneration) {
  return clientMessageIdOf(generation.user_message) || clientMessageIdOf(generation.assistant_message);
}

export function isGenerationForActiveRequest(generation: ChatGeneration, activeRequest: ActiveChatRequest | null) {
  if (!activeRequest) return true;
  const generationClientId = generationClientMessageId(generation);
  return !generationClientId || generationClientId === activeRequest.clientMessageId;
}
