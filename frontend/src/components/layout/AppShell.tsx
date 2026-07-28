import { useEffect, useRef } from "react";
import { PanelLeftOpen } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChatProvider } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { CallProvider } from "../../features/calls/CallProvider";
import { CallOverlay } from "../../features/calls/CallOverlay";
import { AndroidBackHandler } from "./AndroidBackHandler";
import { useMotionMode } from "../../motion/MotionProvider";
import { parseNotificationDestination, routeForNotificationDestination } from "../../notifications/notificationDestination";
import "../../features/calls/calls.css";

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { safeMode, safeModeReason, disableSafeMode } = useMotionMode();
  const consumedDestinationIds = useRef(new Set<string>());
  const {
    closeSidebar,
    expandSidebar,
    isSidebarCollapsed
  } = useShell();
  const fullCanvasAdmin = location.pathname.startsWith("/admin/live-pages");
  const fullCanvasHub = location.pathname === "/hub" || location.pathname === "/activity";
  const callHubWorkspace = location.pathname.startsWith("/call-hub/");

  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, location.pathname]);

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
    const pending = window.localStorage.getItem("auto-ai-pending-destination");
    if (pending) openDestination(new CustomEvent("auto-ai-open-destination", { detail: pending }));
    return () => window.removeEventListener("auto-ai-open-destination", openDestination);
  }, [navigate]);

  useEffect(() => {
    const clearConsumedDestination = (event: Event) => {
      const eventId = event instanceof CustomEvent && typeof event.detail?.eventId === "string" ? event.detail.eventId : "";
      const pending = parseNotificationDestination(window.localStorage.getItem("auto-ai-pending-destination"));
      if (pending?.eventId === eventId) window.localStorage.removeItem("auto-ai-pending-destination");
    };
    window.addEventListener("auto-ai-destination-consumed", clearConsumedDestination);
    return () => window.removeEventListener("auto-ai-destination-consumed", clearConsumedDestination);
  }, []);

  return (
      <CallProvider>
          <ChatProvider>
          <AndroidBackHandler />
          <div className="app-shell">
            {!fullCanvasAdmin && !fullCanvasHub && <Sidebar />}
            {!fullCanvasAdmin && !fullCanvasHub && isSidebarCollapsed && (
              <button
                className="sidebar-restore-button hidden md:inline-flex"
                onClick={expandSidebar}
                title="Show chat history"
                type="button"
              >
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
              {!fullCanvasAdmin && !fullCanvasHub && !callHubWorkspace && <Header />}
              <div className="route-transition-stage" key={`${location.pathname}${location.search}`}>
                <Outlet />
              </div>
            </main>
            <CallOverlay />
          </div>
          </ChatProvider>
      </CallProvider>
  );
}
