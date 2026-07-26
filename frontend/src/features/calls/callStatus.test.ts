import { describe, expect, it } from "vitest";
import { callStatusPresentation } from "./callStatus";

describe("call status presentation", () => {
  it.each([
    ["active", "success", "#22C55E"],
    ["connecting", "processing", "#22D3EE"],
    ["reconnecting", "recovery", "#F59E0B"],
    ["failed", "error", "#EF4444"],
    ["ended", "neutral", "#94A3B8"],
  ] as const)("maps %s to one %s semantic", (state, semantic, color) => {
    expect(callStatusPresentation(state)).toMatchObject({ semantic, color });
  });
});
