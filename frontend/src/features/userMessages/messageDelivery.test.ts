import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client";
import { failOptimisticMessage, messageSendError, replaceOptimisticMessage } from "./messageDelivery";
import type { UserMessage } from "./types";

const pending: UserMessage = {
  id: "local-client-1",
  thread_id: "thread-1",
  sender_id: "sender-1",
  client_message_id: "client-1",
  message_type: "text",
  text_content: "hello",
  created_at: new Date().toISOString(),
  status: "sending",
};

describe("message delivery state", () => {
  it("replaces the original optimistic bubble without duplicating it", () => {
    const saved = { ...pending, id: "server-1", status: "sent" as const };
    const result = replaceOptimisticMessage([pending], "client-1", saved);
    expect(result).toEqual([saved]);
    expect(result).toHaveLength(1);
  });

  it("marks only the matching optimistic message failed", () => {
    expect(failOptimisticMessage([pending], "client-1")[0].status).toBe("failed");
  });

  it.each([
    [401, "session expired"], [403, "permission"], [404, "no longer available"],
    [429, "Too many"], [503, "temporarily unavailable"],
  ])("maps HTTP %s to a relevant safe message", (status, expected) => {
    const error = new ApiClientError("request failed", { kind: "http_error", status });
    expect(messageSendError(error)).toContain(expected);
  });
});
