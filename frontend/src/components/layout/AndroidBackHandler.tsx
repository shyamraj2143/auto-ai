import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useShell } from "../../contexts/ShellContext";
import { useCallSession } from "../../features/calls/hooks/useCallSession";
import { isAdminPanelRole } from "../../utils/roles";

const BACK_EVENT = "auto-ai-android-back";
const MINIMIZE_CALL_EVENT = "auto-ai-minimize-call-overlay";
const EXIT_CONFIRM_MS = 2000;
const MAX_STACK = 32;
const STACK_KEY = "auto-ai-android-route-stack";
const AUTH_OR_EXTERNAL_ROUTES = [
  "/login",
  "/register",
  "/reset-password",
  "/admin/login",
  "/payment/checkout",
  "/payment/success",
  "/payment/failed",
  "/download",
  "/pricing",
  "/home",
  "/"
];
const ROOT_ROUTES = new Set(["/hub", "/admin"]);
const TERMINAL_CALL_STATES = new Set(["idle", "ended", "rejected", "cancelled", "missed", "busy", "failed"]);

function isAndroidCapacitor() {
  if (typeof window === "undefined") return false;
  return Capacitor.getPlatform() === "android";
}

function routeFromLocation(location: ReturnType<typeof useLocation>) {
  return `${location.pathname}${location.search}`;
}

function routePath(route: string) {
  return route.split("?")[0] || "/";
}

function isSafeAuthenticatedRoute(route: string) {
  const path = routePath(route);
  if (AUTH_OR_EXTERNAL_ROUTES.includes(path)) return false;
  return path === "/hub" || path === "/activity" || path === "/chat" || path.startsWith("/chat/") || path === "/settings" || path === "/messages" || path.startsWith("/messages/") || path === "/calls" || path === "/admin";
}

function isEditableFocused() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const tagName = active.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || active.isContentEditable;
}

function settingsParentRoute(route: string) {
  const path = routePath(route);
  if (path !== "/settings") return "";
  const query = route.includes("?") ? new URLSearchParams(route.slice(route.indexOf("?"))) : new URLSearchParams();
  return query.has("section") ? "/settings" : "";
}

export function AndroidBackHandler() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isSidebarOpen, closeSidebar } = useShell();
  const callSession = useCallSession();
  const [toastVisible, setToastVisible] = useState(false);
  const stackRef = useRef<string[]>((() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STACK_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((route): route is string => typeof route === "string").slice(-MAX_STACK) : [];
    } catch {
      return [];
    }
  })());
  const stateRef = useRef({
    route: routeFromLocation(location),
    isSidebarOpen,
    userRole: user?.role ?? "",
    sessionState: callSession.sessionState,
    callType: callSession.call?.call_type ?? null
  });
  const lastExitPressRef = useRef(0);
  const toastTimerRef = useRef(0);

  useEffect(() => {
    stateRef.current = {
      route: routeFromLocation(location),
      isSidebarOpen,
      userRole: user?.role ?? "",
      sessionState: callSession.sessionState,
      callType: callSession.call?.call_type ?? null
    };
  }, [callSession.call?.call_type, callSession.sessionState, isSidebarOpen, location, user?.role]);

  useEffect(() => {
    if (!user) {
      stackRef.current = [];
      sessionStorage.removeItem(STACK_KEY);
      return;
    }
    const route = routeFromLocation(location);
    if (!isSafeAuthenticatedRoute(route)) return;
    const stack = stackRef.current;
    if (stack[stack.length - 1] !== route) stack.push(route);
    if (stack.length > MAX_STACK) stack.splice(0, stack.length - MAX_STACK);
    sessionStorage.setItem(STACK_KEY, JSON.stringify(stack));
  }, [location, user]);

  const showExitToast = useCallback(() => {
    setToastVisible(true);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastVisible(false), EXIT_CONFIRM_MS);
  }, []);

  const navigatePreviousSafeRoute = useCallback((currentRoute: string) => {
    const stack = stackRef.current;
    while (stack.length && stack[stack.length - 1] === currentRoute) stack.pop();
    while (stack.length) {
      const previous = stack.pop();
      if (previous && isSafeAuthenticatedRoute(previous)) {
        navigate(previous, { replace: true });
        return true;
      }
    }
    return false;
  }, [navigate]);

  const handleRootExit = useCallback(() => {
    const now = Date.now();
    if (now - lastExitPressRef.current <= EXIT_CONFIRM_MS) {
      setToastVisible(false);
      void App.exitApp();
      return;
    }
    lastExitPressRef.current = now;
    showExitToast();
  }, [showExitToast]);

  const handleBack = useCallback(() => {
    const state = stateRef.current;
    const currentRoute = state.route;

    if (isEditableFocused()) {
      (document.activeElement as HTMLElement).blur();
      return;
    }

    const customEvent = new CustomEvent(BACK_EVENT, { cancelable: true, detail: { route: currentRoute } });
    if (!window.dispatchEvent(customEvent)) return;

    if (state.isSidebarOpen) {
      closeSidebar();
      return;
    }

    const settingsParent = settingsParentRoute(currentRoute);
    if (settingsParent) {
      navigate(settingsParent, { replace: true });
      return;
    }

    const callActive = !TERMINAL_CALL_STATES.has(state.sessionState);
    if (callActive) {
      window.dispatchEvent(new CustomEvent(MINIMIZE_CALL_EVENT));
      if (state.callType === "audio" && !navigatePreviousSafeRoute(currentRoute) && !ROOT_ROUTES.has(routePath(currentRoute))) {
        navigate(isAdminPanelRole(state.userRole) ? "/admin" : "/hub", { replace: true });
      }
      return;
    }

    if (navigatePreviousSafeRoute(currentRoute)) return;

    const path = routePath(currentRoute);
    if (!ROOT_ROUTES.has(path)) {
      navigate(isAdminPanelRole(state.userRole) ? "/admin" : "/hub", { replace: true });
      return;
    }

    handleRootExit();
  }, [closeSidebar, handleRootExit, navigate, navigatePreviousSafeRoute]);

  useEffect(() => {
    if (!isAndroidCapacitor()) return;
    let handle: Awaited<ReturnType<typeof App.addListener>> | undefined;
    let disposed = false;
    void App.addListener("backButton", handleBack).then((result) => {
      if (disposed) {
        void result?.remove?.();
        return;
      }
      handle = result;
    });
    return () => {
      disposed = true;
      window.clearTimeout(toastTimerRef.current);
      void handle?.remove?.();
    };
  }, [handleBack]);

  if (!toastVisible) return null;

  return (
    <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+22px)] left-1/2 z-[130] -translate-x-1/2 rounded-lg border border-cyan-200/25 bg-slate-950/95 px-4 py-2 text-xs font-semibold text-cyan-50 shadow-[0_18px_45px_rgba(0,0,0,0.4)]">
      Press Back again to exit
    </div>
  );
}
