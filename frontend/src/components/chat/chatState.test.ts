import { describe, expect, it } from "vitest";
import type { ChatGeneration, Message } from "../../types";
import {
  appendOptimisticMessages,
  isGenerationForActiveRequest,
  isRequestBusy,
  mergeChatMessages,
  upsertChatMessage
} from "./chatState";

function message(id: string, role: Message["role"], content: string, clientMessageId?: string): Message {
  return {
    id,
    role,
    content,
    created_at: "2026-07-16T00:00:00.000Z",
    message_metadata: clientMessageId ? { client_message_id: clientMessageId } : {}
  };
}

function generation(clientMessageId: string, chatId = "chat-1"): ChatGeneration {
  return {
    id: `generation-${clientMessageId}`,
    chat_id: chatId,
    user_message_id: `server-user-${clientMessageId}`,
    assistant_message_id: `server-assistant-${clientMessageId}`,
    status: "running",
    user_message: message(`server-user-${clientMessageId}`, "user", "Hi", clientMessageId),
    assistant_message: message(`server-assistant-${clientMessageId}`, "assistant", "", clientMessageId),
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

describe("chat optimistic state", () => {
  it("adds the first message with a new array reference", () => {
    const current: Message[] = [];
    const next = appendOptimisticMessages(current, [
      message("local-user-1", "user", "Hi", "client-1"),
      message("local-assistant-1", "assistant", "", "client-1")
    ]);

    expect(next).not.toBe(current);
    expect(next.map((item) => item.content)).toEqual(["Hi", ""]);
  });

  it("does not duplicate an optimistic user message when the server message arrives", () => {
    const optimistic = [message("local-user-1", "user", "Hi", "client-1")];
    const server = [message("server-user-1", "user", "Hi", "client-1")];

    const merged = mergeChatMessages(server, optimistic);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("server-user-1");
  });

  it("keeps optimistic first-message state when a new empty chat is created", () => {
    const optimistic = [
      message("local-user-1", "user", "Hi", "client-1"),
      message("local-assistant-1", "assistant", "", "client-1")
    ];

    const merged = mergeChatMessages([], optimistic);

    expect(merged.map((item) => item.id)).toEqual(["local-user-1", "local-assistant-1"]);
  });

  it("reconciles server assistant without duplicating retry identity", () => {
    const current = [
      message("local-user-1", "user", "Hi", "client-1"),
      message("local-assistant-1", "assistant", "", "client-1")
    ];

    const next = upsertChatMessage(current, message("server-assistant-1", "assistant", "Hello", "client-1"));

    expect(next).toHaveLength(2);
    expect(next[1].id).toBe("server-assistant-1");
    expect(next[1].content).toBe("Hello");
  });

  it("ignores stale generation snapshots for another active request", () => {
    expect(
      isGenerationForActiveRequest(generation("old-client"), {
        requestId: "request-2",
        assistantId: "local-assistant-2",
        chatId: "chat-1",
        clientMessageId: "new-client"
      })
    ).toBe(false);
  });

  it("marks only active send states as busy", () => {
    expect(isRequestBusy("saving_user_message")).toBe(true);
    expect(isRequestBusy("connecting")).toBe(true);
    expect(isRequestBusy("streaming")).toBe(true);
    expect(isRequestBusy("failed")).toBe(false);
    expect(isRequestBusy("idle")).toBe(false);
  });
});
