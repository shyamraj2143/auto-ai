import { describe, expect, it } from "vitest";
import { composerModeOption, composerModeValue, selectedModelPayload } from "./composerSelection";

describe("chat composer selection", () => {
  it("maps Normal and Deep to their complete request modes", () => {
    expect(composerModeOption("normal")).toMatchObject({ searchMode: "auto", chatMode: "instant" });
    expect(composerModeOption("deep")).toMatchObject({ searchMode: "deep", chatMode: "deep_research" });
    expect(composerModeValue("deep", "deep_research")).toBe("deep_research");
  });

  it("falls back to Normal for an invalid or inconsistent mode", () => {
    expect(composerModeOption("invalid").value).toBe("instant");
    expect(composerModeValue("web", "normal")).toBe("instant");
  });

  it("always preserves the explicitly selected provider and model", () => {
    expect(selectedModelPayload("groq", "openai/gpt-oss-120b")).toEqual({
      provider: "groq",
      model: "openai/gpt-oss-120b"
    });
  });
});
