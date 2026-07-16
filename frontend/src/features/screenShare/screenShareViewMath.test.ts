import { describe, expect, it } from "vitest";
import { clamp, containSize, constrainScreenSharePan, coverSize, screenShareVideoStyle } from "./screenShareViewMath";

describe("screen share viewer math", () => {
  it("keeps fit mode uncropped by default", () => {
    expect(screenShareVideoStyle("fit", { width: 1080, height: 2400 })).toEqual({
      width: "100%",
      height: "100%",
      objectFit: "contain",
    });
  });

  it("fits a portrait Android screen fully inside a landscape laptop viewport", () => {
    const fitted = containSize({ width: 1080, height: 2400 }, { width: 1920, height: 1080 });
    expect(fitted.width).toBeCloseTo(486);
    expect(fitted.height).toBeCloseTo(1080);
    expect(fitted.width).toBeLessThan(1920);
  });

  it("makes fill mode intentionally crop without stretching", () => {
    expect(screenShareVideoStyle("fill", { width: 3440, height: 1440 })).toEqual({
      width: "100%",
      height: "100%",
      objectFit: "cover",
    });
  });

  it("cover would crop the portrait screenshot case and is therefore not the default", () => {
    const covered = coverSize({ width: 1080, height: 2400 }, { width: 1920, height: 1080 });
    expect(covered.width).toBeCloseTo(1920);
    expect(covered.height).toBeGreaterThan(1080);
  });

  it("renders actual size from source dimensions", () => {
    expect(screenShareVideoStyle("actual", { width: 1920, height: 1080 })).toEqual({
      width: "1920px",
      height: "1080px",
      objectFit: "contain",
    });
  });

  it("constrains pan inside the visible viewport", () => {
    expect(constrainScreenSharePan(900, -900, 2, { width: 800, height: 600 })).toEqual({ x: 400, y: -300 });
  });

  it("centres pan when zoom returns to 1x", () => {
    expect(constrainScreenSharePan(200, 140, 1, { width: 800, height: 600 })).toEqual({ x: 0, y: 0 });
  });

  it("clamps zoom between the supported 1x and 5x range", () => {
    expect(clamp(0.2, 1, 5)).toBe(1);
    expect(clamp(3, 1, 5)).toBe(3);
    expect(clamp(9, 1, 5)).toBe(5);
  });
});
