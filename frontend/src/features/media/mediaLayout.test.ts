import { describe, expect, it } from "vitest";
import { calculateMediaLayout, classifyMediaOrientation } from "./mediaLayout";
import { constrainFloatingPosition, floatingAnchorPosition, nearestFloatingAnchor } from "./floatingPosition";

describe("responsive media layout", () => {
  const layout = (sourceWidth: number, sourceHeight: number, containerWidth: number, containerHeight: number, preferredMode: "fit" | "fill" | "actual" = "fit") =>
    calculateMediaLayout({ sourceWidth, sourceHeight, containerWidth, containerHeight, contentType: "video-call", preferredMode });

  it("centres 1080x2400 portrait media on a 1920x1080 laptop without stretching", () => {
    const result = layout(1080, 2400, 1920, 1080);
    expect(result.sourceOrientation).toBe("portrait");
    expect(result.renderedWidth).toBeLessThanOrEqual(480);
    expect(result.renderedHeight).toBeLessThanOrEqual(1080);
    expect(result.offsetX).toBeGreaterThan(700);
    expect(result.objectFit).toBe("contain");
  });

  it("fits 720x1280 portrait media into a 1366x768 laptop", () => {
    const result = layout(720, 1280, 1366, 768);
    expect(result.renderedWidth).toBeCloseTo(432);
    expect(result.renderedHeight).toBeCloseTo(768);
  });

  it.each([[1920, 1080, 390, 844], [2560, 1440, 412, 915]])("fits landscape desktop media completely on mobile", (sw, sh, cw, ch) => {
    const result = layout(sw, sh, cw, ch);
    expect(result.renderedWidth).toBeLessThanOrEqual(cw);
    expect(result.renderedHeight).toBeLessThanOrEqual(ch);
    expect(result.renderedWidth / result.renderedHeight).toBeCloseTo(sw / sh);
  });

  it("handles square and rotated sources", () => {
    expect(classifyMediaOrientation(1000, 1000)).toBe("square");
    expect(classifyMediaOrientation(1080, 1920)).toBe("portrait");
    expect(classifyMediaOrientation(1920, 1080)).toBe("landscape");
  });

  it("returns a safe zero layout before loadedmetadata", () => {
    expect(layout(0, 0, 390, 844).renderedWidth).toBe(0);
  });

  it("uses cover only for explicit Fill", () => {
    expect(layout(1080, 2400, 1920, 1080, "fill").objectFit).toBe("cover");
  });

  it("constrains drag bounds and resolves snap positions", () => {
    const panel = { width: 180, height: 80 };
    const bounds = { width: 390, height: 844, insetBottom: 90 };
    expect(constrainFloatingPosition({ x: -40, y: 900 }, panel, bounds)).toEqual({ x: 12, y: 674 });
    expect(floatingAnchorPosition("bottom-right", panel, bounds)).toEqual({ x: 198, y: 674 });
    expect(nearestFloatingAnchor({ x: 200, y: 670 }, panel, bounds)).toBe("bottom-right");
  });
});
