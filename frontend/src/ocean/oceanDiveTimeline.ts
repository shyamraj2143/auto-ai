import type { OceanDivePhase } from "./oceanStateMachine";

export const OCEAN_DIVE_TIMING = {
  expand: 180,
  crossSurface: 520,
  routeCovered: 760,
  descend: 950,
  settle: 1450,
  complete: 1900,
  cleanup: 1980,
  safety: 2200,
  reducedRoute: 100,
  reducedSettle: 120,
  reducedComplete: 210,
  reducedSafety: 260
} as const;

export const OCEAN_DIVE_PHASE_SCHEDULE: ReadonlyArray<{
  at: number;
  phase: Exclude<OceanDivePhase, "priming">;
}> = [
  { at: OCEAN_DIVE_TIMING.expand, phase: "expanding" },
  { at: OCEAN_DIVE_TIMING.crossSurface, phase: "crossing-surface" },
  { at: OCEAN_DIVE_TIMING.routeCovered, phase: "route-covered" },
  { at: OCEAN_DIVE_TIMING.descend, phase: "descending" },
  { at: OCEAN_DIVE_TIMING.settle, phase: "settling" },
  { at: OCEAN_DIVE_TIMING.complete, phase: "completed" }
];

export function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function timelineProgress(now: number, startedAt: number | null) {
  if (startedAt === null) return 0;
  return clampUnit((now - startedAt) / OCEAN_DIVE_TIMING.complete);
}

export function rangeProgress(progress: number, start: number, end: number) {
  return clampUnit((progress - start) / Math.max(end - start, Number.EPSILON));
}
