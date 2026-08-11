import { describe, expect, it } from "vitest";
import { normalizeChatList } from "./ChatContext";

describe("normalizeChatList", () => {
  it("keeps the workspace renderable when chat sessions are malformed", () => {
    expect(normalizeChatList({ items: [] })).toEqual([]);
    expect(normalizeChatList(null)).toEqual([]);
    expect(normalizeChatList([{ id: "chat-1" }, null, "bad"])).toEqual([{ id: "chat-1" }]);
  });
});
