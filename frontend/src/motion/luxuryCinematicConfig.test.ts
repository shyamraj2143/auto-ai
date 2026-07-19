import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LUXURY_CINEMATIC_CONFIG, shouldDisableLuxuryMotion } from "./luxuryCinematicConfig";

describe("luxury cinematic configuration", () => {
  it("keeps the requested loader easing, heading timing, clip reveal, and parallax distance", () => {
    expect(LUXURY_CINEMATIC_CONFIG.splitEase).toBe("0.77,0,0.175,1");
    expect(LUXURY_CINEMATIC_CONFIG.headingDuration).toBe(1.2);
    expect(LUXURY_CINEMATIC_CONFIG.parallaxPercent).toBe(15);
    expect(LUXURY_CINEMATIC_CONFIG.collapsedClipPath).toBe("polygon(0 100%, 100% 100%, 100% 100%, 0 100%)");
    expect(LUXURY_CINEMATIC_CONFIG.revealedClipPath).toContain("100% 100%");
  });

  it("disables cinematic motion for editors and reduced-motion users", () => {
    expect(shouldDisableLuxuryMotion(true, false)).toBe(true);
    expect(shouldDisableLuxuryMotion(false, true)).toBe(true);
    expect(shouldDisableLuxuryMotion(false, false)).toBe(false);
  });

  it("uses GSAP lifecycle cleanup and avoids a permanent render loop", () => {
    const source = readFileSync(new URL("../hooks/useLuxuryCinematic.ts", import.meta.url), "utf8");
    expect(source).toContain("ScrollTrigger");
    expect(source).toContain("context?.revert()");
    expect(source).toContain("prefers-reduced-motion: reduce");
    expect(source).toContain("loadTimeline.progress(1)");
    expect(source).toContain("2800");
    expect(source).not.toMatch(/requestAnimationFrame|setInterval/);
  });
});
