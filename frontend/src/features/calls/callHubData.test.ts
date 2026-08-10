import { describe, expect, it } from "vitest";
import { asArray, pageCount, pageItems } from "./callHubData";

describe("Call Hub response normalization", () => {
  it("turns missing and malformed collections into safe empty arrays", () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray({})).toEqual([]);
    expect(pageItems(undefined)).toEqual([]);
    expect(pageItems({})).toEqual([]);
    expect(pageItems({ items: null })).toEqual([]);
  });

  it("preserves valid collections and finite non-negative counts", () => {
    const items = [{ id: "one" }];
    expect(pageItems({ items })).toBe(items);
    expect(pageCount({ unread_count: 4 }, "unread_count")).toBe(4);
    expect(pageCount({ unread_count: -2 }, "unread_count")).toBe(0);
    expect(pageCount({ unread_count: "4" }, "unread_count")).toBe(0);
  });
});
