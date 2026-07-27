import { describe, expect, it } from "vitest";
import { NavigationHistoryController } from "./navigationHistory";
import { messageBackDestination } from "./AndroidBackHandler";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
}

describe("NavigationHistoryController", () => {
  it("preserves query strings and prevents duplicate routes", () => {
    const history = new NavigationHistoryController(memoryStorage(), "routes");
    history.record("/settings", "?section=calls", "a", 1);
    history.record("/settings", "?section=calls", "b", 2);
    expect(history.snapshot()).toEqual([{ pathname: "/settings", search: "?section=calls", key: "a", timestamp: 1 }]);
  });

  it("returns the previous safe route", () => {
    const history = new NavigationHistoryController(memoryStorage(), "routes");
    history.record("/hub", "", "a", 1);
    history.record("/messages", "", "b", 2);
    history.record("/messages/thread", "?focus=1", "c", 3);
    expect(history.previous("/messages/thread?focus=1", () => true)).toBe("/messages");
  });

  it("keeps only forty entries", () => {
    const history = new NavigationHistoryController(memoryStorage(), "routes");
    for (let index = 0; index < 45; index += 1) history.record(`/chat/${index}`, "", String(index), index);
    expect(history.snapshot()).toHaveLength(40);
    expect(history.snapshot()[0].pathname).toBe("/chat/5");
  });
});

describe("message back navigation", () => {
  it("returns a conversation to the list and the list to Hub", () => {
    expect(messageBackDestination("/messages/thread-1?focus=latest")).toBe("/messages");
    expect(messageBackDestination("/messages?filter=unread")).toBe("/hub");
  });
});
