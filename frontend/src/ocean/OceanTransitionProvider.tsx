import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMotionMode } from "../motion/MotionProvider";
import { OCEAN_DIVE_PHASE_SCHEDULE, OCEAN_DIVE_TIMING } from "./oceanDiveTimeline";
import { decideOceanNavigation } from "./oceanNavigation";
import {
  createOceanState,
  isOceanDivePhase,
  oceanReducer,
  oceanRouteFromPath,
  type OceanRoute
} from "./oceanStateMachine";
import { isOceanDebugEnabled, oceanDebugStateLabel, updateOceanDebug } from "./oceanDebug";
import "./oceanExperience.css";

const LazyOceanExperienceBackground = lazy(() =>
  import("./OceanExperienceBackground").then((module) => ({ default: module.OceanExperienceBackground }))
);

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type PendingNavigation = {
  destination: string;
  navigated: boolean;
};

type OceanRendererBoundaryProps = {
  children: ReactNode;
  onFailure: (error?: unknown) => void;
};

class OceanRendererBoundary extends Component<OceanRendererBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error("[Abyssal Prism Current] React renderer failed; using the CSS fallback.", error, info);
    }
    this.props.onFailure(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function OceanTransitionProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const motion = useMotionMode();
  const oceanDebug = isOceanDebugEnabled();
  const route = oceanRouteFromPath(location.pathname);
  const routeRef = useRef<OceanRoute>(route);
  const [state, dispatch] = useReducer(oceanReducer, route, createOceanState);
  const oceanReducedMotion = !oceanDebug && (motion.preference === "reduced" || motion.safeMode);
  const [shouldLoadRenderer, setShouldLoadRenderer] = useState(oceanDebug);
  const [rendererStatus, setRendererStatus] = useState<"pending" | "webgl" | "fallback">("pending");
  const [quality, setQuality] = useState("pending");
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const previousReducedMotionRef = useRef(oceanReducedMotion);
  const phaseTimersRef = useRef<number[]>([]);
  const routeTimerRef = useRef(0);
  const maximumTimerRef = useRef(0);
  const cleanupTimerRef = useRef(0);
  const activeRoute = route !== "none";
  const diveActive = isOceanDivePhase(state.phase);
  const debugState = oceanDebugStateLabel(state.phase);

  routeRef.current = route;

  const clearNavigationTimers = useCallback(() => {
    phaseTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    phaseTimersRef.current = [];
    window.clearTimeout(routeTimerRef.current);
    window.clearTimeout(maximumTimerRef.current);
    window.clearTimeout(cleanupTimerRef.current);
  }, []);

  const performPendingNavigation = useCallback(() => {
    const pending = pendingNavigationRef.current;
    if (!pending || pending.navigated) return;
    pending.navigated = true;
    try {
      navigate(pending.destination);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[Abyssal Prism Current] Router navigation failed; falling back to browser navigation.", error);
      }
      window.location.assign(pending.destination);
    }
  }, [navigate]);

  const finishPendingTransition = useCallback(() => {
    performPendingNavigation();
    dispatch({ type: "FINISH_DIVE" });
    pendingNavigationRef.current = null;
    clearNavigationTimers();
  }, [clearNavigationTimers, performPendingNavigation]);

  const scheduleDive = useCallback((useReducedMotion: boolean) => {
    const schedulePhase = (at: number, phase: Parameters<typeof dispatch>[0] & { type: "ADVANCE_DIVE" }) => {
      phaseTimersRef.current.push(window.setTimeout(() => dispatch(phase), at));
    };

    if (useReducedMotion) {
      schedulePhase(OCEAN_DIVE_TIMING.reducedRoute, { type: "ADVANCE_DIVE", phase: "route-covered" });
      schedulePhase(OCEAN_DIVE_TIMING.reducedSettle, { type: "ADVANCE_DIVE", phase: "settling" });
      routeTimerRef.current = window.setTimeout(performPendingNavigation, OCEAN_DIVE_TIMING.reducedRoute);
      cleanupTimerRef.current = window.setTimeout(finishPendingTransition, OCEAN_DIVE_TIMING.reducedComplete);
      maximumTimerRef.current = window.setTimeout(finishPendingTransition, OCEAN_DIVE_TIMING.reducedSafety);
      return;
    }

    OCEAN_DIVE_PHASE_SCHEDULE.forEach(({ at, phase }) => {
      schedulePhase(at, { type: "ADVANCE_DIVE", phase });
    });
    routeTimerRef.current = window.setTimeout(performPendingNavigation, OCEAN_DIVE_TIMING.routeCovered);
    cleanupTimerRef.current = window.setTimeout(finishPendingTransition, OCEAN_DIVE_TIMING.cleanup);
    maximumTimerRef.current = window.setTimeout(finishPendingTransition, OCEAN_DIVE_TIMING.safety);
  }, [finishPendingTransition, performPendingNavigation]);

  const handleRendererFailure = useCallback((error?: unknown) => {
    setRendererStatus("fallback");
    updateOceanDebug({
      renderer: "fallback",
      shaderStatus: "failure",
      lastError: error instanceof Error ? error.message : String(error ?? "Renderer failed.")
    });
    dispatch({ type: "FAIL" });
    if (!pendingNavigationRef.current) return;
    clearNavigationTimers();
    performPendingNavigation();
    pendingNavigationRef.current = null;
  }, [clearNavigationTimers, performPendingNavigation]);

  const handleRendererReady = useCallback(() => {
    setRendererStatus("webgl");
    updateOceanDebug({ renderer: "webgl", shaderStatus: "success", lastError: null });
    dispatch({ type: "RESTORE", route: routeRef.current });
  }, []);

  const handleInteractionChange = useCallback((isActive: boolean) => {
    dispatch({ type: isActive ? "POINTER_ACTIVE" : "POINTER_IDLE" });
  }, []);

  const handleQualityChange = useCallback((nextQuality: string) => {
    setQuality((current) => current === nextQuality ? current : nextQuality);
    updateOceanDebug({ quality: nextQuality });
  }, []);

  useEffect(() => {
    if (route === "home") dispatch({ type: "ROUTE_HOME" });
    if (route === "auth") dispatch({ type: "ROUTE_AUTH" });
  }, [route]);

  useEffect(() => {
    document.documentElement.classList.toggle("ocean-debug", oceanDebug);
    return () => document.documentElement.classList.remove("ocean-debug");
  }, [oceanDebug]);

  useEffect(() => {
    updateOceanDebug({
      mounted: activeRoute,
      renderer: oceanReducedMotion ? "reduced" : rendererStatus,
      state: debugState,
      reducedMotion: oceanReducedMotion,
      quality
    });
  }, [activeRoute, debugState, oceanReducedMotion, quality, rendererStatus]);

  useEffect(() => {
    document.body.classList.toggle("ocean-route-active", activeRoute);
    document.body.classList.toggle("ocean-dive-active", diveActive);
    return () => {
      document.body.classList.remove("ocean-route-active");
      document.body.classList.remove("ocean-dive-active");
    };
  }, [activeRoute, diveActive]);

  useEffect(() => {
    const becameReduced = oceanReducedMotion && !previousReducedMotionRef.current;
    previousReducedMotionRef.current = oceanReducedMotion;
    if (!becameReduced || !pendingNavigationRef.current) return;
    clearNavigationTimers();
    scheduleDive(true);
  }, [clearNavigationTimers, oceanReducedMotion, scheduleDive]);

  useEffect(() => {
    if (!activeRoute || oceanReducedMotion || shouldLoadRenderer) return;
    const idleWindow = window as IdleWindow;
    let cancelled = false;
    const load = () => {
      if (!cancelled) setShouldLoadRenderer(true);
    };
    const idleHandle = idleWindow.requestIdleCallback?.(load, { timeout: 700 });
    const fallbackTimer = window.setTimeout(load, idleHandle === undefined ? 180 : 760);
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle);
    };
  }, [activeRoute, oceanReducedMotion, shouldLoadRenderer]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) dispatch({ type: "PAUSE" });
      else dispatch({ type: "RESUME", route: routeRef.current });
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;

      let destination: URL;
      try {
        destination = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }

      const decision = decideOceanNavigation({
        currentPath: location.pathname,
        destinationPath: destination.pathname,
        sameOrigin: destination.origin === window.location.origin,
        button: event.button,
        modified: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
        opensNewContext: Boolean(anchor.target && anchor.target.toLowerCase() !== "_self"),
        download: anchor.hasAttribute("download"),
        defaultPrevented: event.defaultPrevented,
        reducedMotion: oceanReducedMotion,
        navigationPending: pendingNavigationRef.current !== null
      });

      if (decision === "ignore") return;
      event.preventDefault();
      if (decision === "block") return;

      clearNavigationTimers();
      pendingNavigationRef.current = {
        destination: (() => {
          if (oceanDebug && destination.origin === window.location.origin) {
            destination.searchParams.set("oceanDebug", "1");
          }
          return `${destination.pathname}${destination.search}${destination.hash}`;
        })(),
        navigated: false
      };
      dispatch({ type: "START_DIVE", now: performance.now() });
      scheduleDive(decision === "dissolve");
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [clearNavigationTimers, location.pathname, oceanDebug, oceanReducedMotion, scheduleDive]);

  useEffect(() => () => {
    clearNavigationTimers();
    pendingNavigationRef.current = null;
  }, [clearNavigationTimers]);

  const renderedRoute = route === "none" ? null : route;

  return (
    <>
      {renderedRoute && (
        <div
          aria-hidden="true"
          className="ocean-experience"
          data-ocean-active={diveActive ? "true" : "false"}
          data-ocean-host="persistent"
          data-ocean-debug={oceanDebug ? "true" : "false"}
          data-ocean-quality={quality}
          data-ocean-reduced={oceanReducedMotion ? "true" : "false"}
          data-ocean-renderer={oceanReducedMotion ? "reduced" : rendererStatus}
          data-ocean-route={renderedRoute}
          data-ocean-state={debugState}
        >
          <div className="ocean-experience-fallback" />
          {shouldLoadRenderer && !oceanReducedMotion && (
            <OceanRendererBoundary onFailure={handleRendererFailure}>
              <Suspense fallback={null}>
                <LazyOceanExperienceBackground
                  debug={oceanDebug}
                  onFailure={handleRendererFailure}
                  onInteractionChange={handleInteractionChange}
                  onQualityChange={handleQualityChange}
                  onReady={handleRendererReady}
                  phase={state.phase}
                  route={renderedRoute}
                  transitionStartedAt={state.transitionStartedAt}
                />
              </Suspense>
            </OceanRendererBoundary>
          )}
          <div className="ocean-experience-contrast" />
        </div>
      )}
      {children}
    </>
  );
}
