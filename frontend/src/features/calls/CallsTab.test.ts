import { describe, expect, it } from "vitest";
import { CALL_HUB_SECTIONS } from "./CallsTab";

describe("Call Hub navigation", () => {
  it("contains exactly the five production sections", () => {
    expect(CALL_HUB_SECTIONS).toEqual(["search", "requests", "chats", "calls", "alerts"]);
  });
});
