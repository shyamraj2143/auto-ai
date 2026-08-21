import { useEffect, useRef, type ReactNode } from "react";
import { PanelLeftOpen } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChatProvider } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { Sidebar } from "./Sidebar";
import { WorkspaceMobileNavigation, WorkspaceNavigation } from "./WorkspaceNavigation";
import { CallProvider } from "../../features/calls/CallProvider";
import { CallOverlay } from "../../features/calls/CallOverlay";
import { AndroidBackHandler } from "./AndroidBackHandler";
import { useMotionMode } from "../../motion/MotionProvider";
import { parseNotificationDestination, routeForNotificationDestination } from "../../notifications/notificationDestination";
import "../../features/calls/calls.css";
import { AlarmProvider } from "../../features/alarms/AlarmContext";
import { AlarmOverlay } from "../../features/alarms/AlarmOverlay";
import { NetworkStatusMonitor } from "../common/NetworkStatusMonitor";

function AlarmWorkspaceScope({ enabled, nativeEnabled, children }: { enabled: boolean; nativeEnabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return <AlarmProvider nativeEnabled={nativeEnabled}>{children}<AlarmOverlay /></AlarmProvider>;
}

function CallWorkspaceScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return (
    <CallProvider>
      <AndroidBackHandler />
      {children}
      <CallOverlay />
    </CallProvider>
  );
}

function ChatWorkspaceScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return <ChatProvider>{children}</ChatProvider>;
}

function readLocalStorageValue(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    console.warn("[Auto-AI Shell] Unable to read local storage.", error);
    return null;
  }
}

function removeLocalStorageValue(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn("[Auto-AI Shell] Unable to clear local storage.", error);
  }
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { safeMode, safeModeReason, disableSafeMode } = useMotionMode();
  const consumedDestinationIds = useRef(new Set<string>());
  const { closeSidebar, expandSidebar, isSidebarCollapsed, isSidebarOpen } = useShell();
  const fullCanvasAdmin = location.pathname.startsWith("/admin/live-pages");
  const isAdminRoute = location.pathname.startsWith("/admin");
  const isChatWorkspace = location.pathname.startsWith("/chat");
  const isSettingsWorkspace = location.pathname === "/settings";
  const needsChatContext = isChatWorkspace || isSettingsWorkspace;
  const isDashboard = location.pathname === "/hub";
  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, location.pathname]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const updateKeyboardState = () => {
      if (document.documentElement.dataset.nativeInsets === "true") return;
      const keyboardOpen = window.innerHeight - viewport.height > 150;
      document.documentElement.classList.toggle("autoai-keyboard-open", keyboardOpen);
    };
    updateKeyboardState();
    viewport.addEventListener("resize", updateKeyboardState);
    viewport.addEventListener("scroll", updateKeyboardState);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardState);
      viewport.removeEventListener("scroll", updateKeyboardState);
      if (document.documentElement.dataset.nativeInsets !== "true") document.documentElement.classList.remove("autoai-keyboard-open");
    };
  }, []);

  useEffect(() => {
    const openDestination = (event: Event) => {
      const destination = parseNotificationDestination(event instanceof CustomEvent ? event.detail : null);
      if (!destination || consumedDestinationIds.current.has(destination.eventId)) return;
      const route = routeForNotificationDestination(destination);
      if (!route) return;
      consumedDestinationIds.current.add(destination.eventId);
      if (consumedDestinationIds.current.size > 200) consumedDestinationIds.current.clear();
      navigate(route, { replace: false });
      window.dispatchEvent(new CustomEvent("auto-ai-destination-consumed", { detail: { eventId: destination.eventId } }));
    };
    window.addEventListener("auto-ai-open-destination", openDestination);
    const pending = readLocalStorageValue("auto-ai-pending-destination");
    if (pending) openDestination(new CustomEvent("auto-ai-open-destination", { detail: pending }));
    return () => window.removeEventListener("auto-ai-open-destination", openDestination);
  }, [navigate]);

  useEffect(() => {
    const clearConsumedDestination = (event: Event) => {
      const eventId = event instanceof CustomEvent && typeof event.detail?.eventId === "string" ? event.detail.eventId : "";
      const pending = parseNotificationDestination(readLocalStorageValue("auto-ai-pending-destination"));
      if (pending?.eventId === eventId) removeLocalStorageValue("auto-ai-pending-destination");
    };
    window.addEventListener("auto-ai-destination-consumed", clearConsumedDestination);
    return () => window.removeEventListener("auto-ai-destination-consumed", clearConsumedDestination);
  }, []);

  const workspace = (
    <div className={`app-shell${isSidebarOpen ? " sidebar-open" : ""}${isChatWorkspace ? " chat-app-shell" : ""}`}>
      {!fullCanvasAdmin && <WorkspaceNavigation />}
      {!fullCanvasAdmin && isChatWorkspace && <Sidebar />}
      {!fullCanvasAdmin && isChatWorkspace && isSidebarCollapsed && (
        <button className="sidebar-restore-button hidden md:inline-flex" onClick={expandSidebar} title="Show chat history" type="button">
          <PanelLeftOpen size={17} />
        </button>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {safeMode && (
          <div className="safe-mode-banner" role="status">
            <span>Safe Mode active{safeModeReason ? `: ${safeModeReason}` : ""}</span>
            <button type="button" onClick={disableSafeMode}>Exit Safe Mode</button>
          </div>
        )}
        <div className="route-transition-stage" key={`${location.pathname}${location.search}`}>
          <Outlet />
        </div>
      </main>
      {!fullCanvasAdmin && <WorkspaceMobileNavigation />}
      {isDashboard && <NetworkStatusMonitor />}
    </div>
  );

  const alarmScoped = (
    <AlarmWorkspaceScope enabled={!isAdminRoute} nativeEnabled={!isAdminRoute}>
      {workspace}
    </AlarmWorkspaceScope>
  );

  const chatScoped = <ChatWorkspaceScope enabled={needsChatContext}>{alarmScoped}</ChatWorkspaceScope>;
  return <CallWorkspaceScope enabled={!isAdminRoute}>{chatScoped}</CallWorkspaceScope>;
}