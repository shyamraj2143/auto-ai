import { describe, expect, it } from "vitest";
import { MAX_PARTICIPATING_MODELS, clampParticipatingModels } from "./limits";

describe("participating model limit", () => {
  it("hard caps all values at six", () => {
    expect(MAX_PARTICIPATING_MODELS).toBe(6);
    expect(clampParticipatingModels(9)).toBe(6);
    expect(clampParticipatingModels(50)).toBe(6);
  });

  it("preserves deliberate lower selections", () => {
    expect(clampParticipatingModels(2)).toBe(2);
    expect(clampParticipatingModels(5)).toBe(5);
  });
});
