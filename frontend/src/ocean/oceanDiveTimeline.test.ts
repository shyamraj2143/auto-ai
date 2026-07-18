import { describe, expect, it } from "vitest";
import { OCEAN_DIVE_PHASE_SCHEDULE, OCEAN_DIVE_TIMING, rangeProgress, timelineProgress } from "./oceanDiveTimeline";

describe("ocean dive timeline", () => {
  it("covers the old route before navigating and settles within the safety limit", () => {
    const covered = OCEAN_DIVE_PHASE_SCHEDULE.find(({ phase }) => phase === "route-covered");
    expect(covered?.at).toBe(OCEAN_DIVE_TIMING.routeCovered);
    expect(OCEAN_DIVE_TIMING.routeCovered).toBeLessThan(OCEAN_DIVE_TIMING.descend);
    expect(OCEAN_DIVE_TIMING.cleanup).toBeLessThan(OCEAN_DIVE_TIMING.safety);
    expect(OCEAN_DIVE_TIMING.safety).toBe(2200);
  });

  it("keeps reduced motion within a 150-250 ms visual duration", () => {
    expect(OCEAN_DIVE_TIMING.reducedComplete).toBeGreaterThanOrEqual(150);
    expect(OCEAN_DIVE_TIMING.reducedComplete).toBeLessThanOrEqual(250);
    expect(OCEAN_DIVE_TIMING.reducedRoute).toBeLessThan(OCEAN_DIVE_TIMING.reducedComplete);
  });

  it("returns clamped monotonic shader progress", () => {
    expect(timelineProgress(100, null)).toBe(0);
    expect(timelineProgress(100, 100)).toBe(0);
    expect(timelineProgress(1050, 100)).toBe(0.5);
    expect(timelineProgress(4000, 100)).toBe(1);
    expect(rangeProgress(0.5, 0.25, 0.75)).toBe(0.5);
  });
});
