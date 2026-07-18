import { describe, expect, it } from "vitest";
import { createOceanState, oceanReducer, oceanRouteFromPath } from "./oceanStateMachine";

describe("ocean experience state machine", () => {
  it("moves through every dive phase and keeps the route switch covered", () => {
    const idle = createOceanState("home");
    const priming = oceanReducer(idle, { type: "START_DIVE", now: 125 });
    const expanding = oceanReducer(priming, { type: "ADVANCE_DIVE", phase: "expanding" });
    const crossing = oceanReducer(expanding, { type: "ADVANCE_DIVE", phase: "crossing-surface" });
    const covered = oceanReducer(crossing, { type: "ADVANCE_DIVE", phase: "route-covered" });
    const afterRoute = oceanReducer(covered, { type: "ROUTE_AUTH" });
    const descending = oceanReducer(afterRoute, { type: "ADVANCE_DIVE", phase: "descending" });
    const settling = oceanReducer(descending, { type: "ADVANCE_DIVE", phase: "settling" });
    const completed = oceanReducer(settling, { type: "ADVANCE_DIVE", phase: "completed" });
    const calm = oceanReducer(completed, { type: "FINISH_DIVE" });

    expect(priming).toMatchObject({ phase: "priming", transitionStartedAt: 125 });
    expect(afterRoute).toBe(covered);
    expect(descending.phase).toBe("descending");
    expect(settling.phase).toBe("settling");
    expect(completed.phase).toBe("completed");
    expect(calm).toEqual({ phase: "auth-calm", resumePhase: null, transitionStartedAt: null });
  });

  it("rejects duplicate, reversed, and illegal phase transitions", () => {
    const priming = oceanReducer(createOceanState("home"), { type: "START_DIVE", now: 100 });
    const expanding = oceanReducer(priming, { type: "ADVANCE_DIVE", phase: "expanding" });
    expect(oceanReducer(priming, { type: "START_DIVE", now: 200 })).toBe(priming);
    expect(oceanReducer(expanding, { type: "ADVANCE_DIVE", phase: "expanding" })).toBe(expanding);
    expect(oceanReducer(expanding, { type: "ADVANCE_DIVE", phase: "crossing-surface" }).phase).toBe("crossing-surface");
  });

  it("can start the CSS fallback dive when WebGL is unavailable", () => {
    const fallback = oceanReducer(createOceanState("home"), { type: "FAIL" });
    expect(oceanReducer(fallback, { type: "START_DIVE", now: 200 }).phase).toBe("priming");
  });

  it("pauses while hidden and restores the route-safe calm state", () => {
    const paused = oceanReducer(createOceanState("home"), { type: "PAUSE" });
    expect(paused.phase).toBe("paused");
    expect(oceanReducer(paused, { type: "RESUME", route: "home" }).phase).toBe("idle");
  });

  it("keeps a failed renderer in fallback until restoration", () => {
    const failed = oceanReducer(createOceanState("home"), { type: "FAIL" });
    expect(oceanReducer(failed, { type: "ROUTE_AUTH" }).phase).toBe("auth-calm");
    expect(oceanReducer(failed, { type: "RESTORE", route: "auth" }).phase).toBe("auth-calm");
  });

  it("limits the experience to home and user auth routes", () => {
    expect(oceanRouteFromPath("/")).toBe("home");
    expect(oceanRouteFromPath("/login")).toBe("auth");
    expect(oceanRouteFromPath("/register")).toBe("auth");
    expect(oceanRouteFromPath("/admin/live-pages/home")).toBe("none");
  });
});
