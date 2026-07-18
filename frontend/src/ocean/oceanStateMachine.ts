export type OceanDivePhase =
  | "priming"
  | "expanding"
  | "crossing-surface"
  | "route-covered"
  | "descending"
  | "settling"
  | "completed";

export type OceanPhase =
  | "idle"
  | "home-reactive"
  | OceanDivePhase
  | "auth-calm"
  | "paused"
  | "fallback";

export type OceanRoute = "home" | "auth" | "none";

export type OceanState = {
  phase: OceanPhase;
  resumePhase: Exclude<OceanPhase, "paused"> | null;
  transitionStartedAt: number | null;
};

export type OceanEvent =
  | { type: "POINTER_ACTIVE" }
  | { type: "POINTER_IDLE" }
  | { type: "START_DIVE"; now: number }
  | { type: "ADVANCE_DIVE"; phase: Exclude<OceanDivePhase, "priming"> }
  | { type: "ROUTE_HOME" }
  | { type: "ROUTE_AUTH" }
  | { type: "FINISH_DIVE" }
  | { type: "PAUSE" }
  | { type: "RESUME"; route: OceanRoute }
  | { type: "FAIL" }
  | { type: "RESTORE"; route: OceanRoute };

const DIVE_PHASE_ORDER: readonly OceanDivePhase[] = [
  "priming",
  "expanding",
  "crossing-surface",
  "route-covered",
  "descending",
  "settling",
  "completed"
];

export function isOceanDivePhase(phase: OceanPhase): phase is OceanDivePhase {
  return (DIVE_PHASE_ORDER as readonly OceanPhase[]).includes(phase);
}

export function oceanRouteFromPath(pathname: string): OceanRoute {
  if (pathname === "/") return "home";
  if (pathname === "/login" || pathname === "/register") return "auth";
  return "none";
}

export function oceanPhaseForRoute(route: OceanRoute): OceanPhase {
  if (route === "home") return "idle";
  if (route === "auth") return "auth-calm";
  return "fallback";
}

export function createOceanState(route: OceanRoute): OceanState {
  return {
    phase: oceanPhaseForRoute(route),
    resumePhase: null,
    transitionStartedAt: null
  };
}

export function oceanReducer(state: OceanState, event: OceanEvent): OceanState {
  switch (event.type) {
    case "POINTER_ACTIVE":
      return state.phase === "idle" ? { ...state, phase: "home-reactive" } : state;
    case "POINTER_IDLE":
      return state.phase === "home-reactive" ? { ...state, phase: "idle" } : state;
    case "START_DIVE":
      if (state.phase !== "idle" && state.phase !== "home-reactive" && state.phase !== "auth-calm" && state.phase !== "fallback") {
        return state;
      }
      return { phase: "priming", resumePhase: null, transitionStartedAt: event.now };
    case "ADVANCE_DIVE": {
      if (!isOceanDivePhase(state.phase)) return state;
      const currentIndex = DIVE_PHASE_ORDER.indexOf(state.phase);
      const nextIndex = DIVE_PHASE_ORDER.indexOf(event.phase);
      return nextIndex > currentIndex ? { ...state, phase: event.phase } : state;
    }
    case "ROUTE_HOME":
      if (isOceanDivePhase(state.phase)) return state;
      return { phase: "idle", resumePhase: null, transitionStartedAt: null };
    case "ROUTE_AUTH":
      if (isOceanDivePhase(state.phase)) return state;
      return { phase: "auth-calm", resumePhase: null, transitionStartedAt: null };
    case "FINISH_DIVE":
      return isOceanDivePhase(state.phase)
        ? { phase: "auth-calm", resumePhase: null, transitionStartedAt: null }
        : state;
    case "PAUSE":
      if (state.phase === "paused") return state;
      return { ...state, phase: "paused", resumePhase: state.phase };
    case "RESUME":
      if (state.phase !== "paused") return state;
      if (state.resumePhase === "fallback") {
        return { phase: "fallback", resumePhase: null, transitionStartedAt: null };
      }
      return {
        phase: oceanPhaseForRoute(event.route),
        resumePhase: null,
        transitionStartedAt: null
      };
    case "FAIL":
      return { phase: "fallback", resumePhase: null, transitionStartedAt: null };
    case "RESTORE":
      if (state.phase !== "fallback") return state;
      return { phase: oceanPhaseForRoute(event.route), resumePhase: null, transitionStartedAt: null };
    default:
      return state;
  }
}
