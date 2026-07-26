import { describe, expect, it } from "vitest";
import { formatMessageTimestamp } from "./MessageBubble";

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
