import { describe, expect, it } from "vitest";
import { detectPreset } from "./PresetDetectionService";

describe("PresetDetectionService", () => {
  it.each([
    ["debug this React API error", false, "coding"],
    ["write a Python database migration", false, "coding"],
    ["compare sources in a comprehensive research report", false, "deep_research"],
    ["prove this result and explain the trade-offs", false, "high"],
    ["hello", false, "instant"],
    ["How should I plan my week with competing priorities and limited time?", false, "medium"],
    ["What is shown here?", true, "high"]
  ] as const)("detects %s as %s", (message, attachment, expected) => {
    expect(detectPreset(message, attachment)).toBe(expected);
  });

  it("is deterministic for normalized whitespace", () => {
    expect(detectPreset("debug   this\nTypeScript code")).toBe(detectPreset("debug this TypeScript code"));
  });
});
