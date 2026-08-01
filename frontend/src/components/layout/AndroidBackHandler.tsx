import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useShell } from "../../contexts/ShellContext";
import { useCallSession } from "../../features/calls/hooks/useCallSession";
import { isAdminPanelRole } from "../../utils/roles";
import { NavigationHistoryController } from "./navigationHistory";

const BACK_EVENT = "auto-ai-android-back";
const NATIVE_BACK_EVENT = "auto-ai-native-back";
const MINIMIZE_CALL_EVENT = "auto-ai-minimize-call-overlay";
const EXIT_CONFIRM_MS = 2000;
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
  return path === "/hub" || path === "/activity" || path === "/alarms" || path === "/chat" || path.startsWith("/chat/") || path === "/settings" || path === "/messages" || path.startsWith("/messages/") || path === "/calls" || path.startsWith("/call-hub/") || path.startsWith("/calls/active/") || path === "/admin";
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

export function messageBackDestination(route: string) {
  const path = routePath(route);
  if (path.startsWith("/messages/")) return "/messages";
  return "";
}

export function AndroidBackHandler() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isSidebarOpen, closeSidebar } = useShell();
  const callSession = useCallSession();
  const [toastVisible, setToastVisible] = useState(false);
  const historyRef = useRef(new NavigationHistoryController(sessionStorage, STACK_KEY));
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
    lastExitPressRef.current = 0;
    setToastVisible(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!user) {
      historyRef.current.clear();
      return;
    }
    const route = routeFromLocation(location);
    if (!isSafeAuthenticatedRoute(route)) return;
    historyRef.current.record(location.pathname, location.search, location.key);
  }, [location, user]);

  const showExitToast = useCallback(() => {
    setToastVisible(true);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastVisible(false), EXIT_CONFIRM_MS);
  }, []);

  const navigatePreviousSafeRoute = useCallback((currentRoute: string) => {
    const previous = historyRef.current.previous(currentRoute, isSafeAuthenticatedRoute);
    if (!previous) return false;
    navigate(previous, { replace: true });
    return true;
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

    const messageParent = messageBackDestination(currentRoute);
    if (messageParent) {
      navigate(messageParent, { replace: true });
      return;
    }

    if (routePath(currentRoute) === "/messages") {
      if (!navigatePreviousSafeRoute(currentRoute)) navigate("/hub", { replace: true });
      return;
    }

    const settingsParent = settingsParentRoute(currentRoute);
    if (settingsParent) {
      navigate(settingsParent, { replace: true });
      return;
    }

    if (routePath(currentRoute).startsWith("/call-hub/")) {
      if (!navigatePreviousSafeRoute(currentRoute)) navigate("/hub", { replace: true });
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
    const onNativeBack = (event: Event) => {
      event.preventDefault();
      handleBack();
    };
    window.addEventListener(NATIVE_BACK_EVENT, onNativeBack);
    return () => window.removeEventListener(NATIVE_BACK_EVENT, onNativeBack);
  }, [handleBack]);

  if (!toastVisible) return null;

  return (
    <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+22px)] left-1/2 z-[130] -translate-x-1/2 rounded-lg border border-cyan-200/25 bg-slate-950/95 px-4 py-2 text-xs font-semibold text-cyan-50 shadow-[0_18px_45px_rgba(0,0,0,0.4)]">
      Press Back again to exit
    </div>
  );
}
