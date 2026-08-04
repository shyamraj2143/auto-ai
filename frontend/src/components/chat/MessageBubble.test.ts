import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import { formatMessageTimestamp, latestServiceTaskMessageIds } from "./MessageBubble";

describe("formatMessageTimestamp", () => {
  it("labels timestamps from today using local time", () => {
    const now = new Date(2026, 6, 26, 12, 0);
    expect(formatMessageTimestamp(new Date(2026, 6, 26, 2, 18).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("labels timestamps from yesterday", () => {
    const now = new Date(2026, 6, 26, 12, 0);
    expect(formatMessageTimestamp(new Date(2026, 6, 25, 22, 30).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });

  it("does not invent a timestamp for invalid data", () => {
    expect(formatMessageTimestamp("invalid")).toBe("");
  });
});

describe("latestServiceTaskMessageIds", () => {
  it("keeps only the newest persisted service card interactive", () => {
    const messages = [
      { id: "message-1", message_metadata: { service_task: { id: "task-a" } } },
      { id: "message-2", message_metadata: { service_task: { id: "task-b" } } },
      { id: "message-3", message_metadata: { service_task: { id: "task-a" } } },
    ] as unknown as Message[];
    const latest = latestServiceTaskMessageIds(messages);
    expect(latest.size).toBe(1);
    expect(latest.has("message-2")).toBe(false);
    expect(latest.has("message-3")).toBe(true);
  });
});
