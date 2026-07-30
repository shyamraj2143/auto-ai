import { describe, expect, it } from "vitest";
import { composerModeOption, composerModeValue } from "./composerSelection";

describe("chat composer selection", () => {
  it("maps Normal and Deep to their complete request modes", () => {
    expect(composerModeOption("normal")).toMatchObject({ searchMode: "auto", chatMode: "instant" });
    expect(composerModeOption("deep")).toMatchObject({ searchMode: "deep", chatMode: "deep_research" });
    expect(composerModeValue("deep", "deep_research")).toBe("deep_research");
  });

  it("maps Coding to the canonical backend preset", () => {
    expect(composerModeOption("coding")).toMatchObject({ searchMode: "auto", chatMode: "coding" });
    expect(composerModeValue("auto", "coding")).toBe("coding");
  });

  it("falls back to Normal for an invalid or inconsistent mode", () => {
    expect(composerModeOption("invalid").value).toBe("instant");
    expect(composerModeValue("web", "normal")).toBe("instant");
  });

});
