import { useEffect, useRef } from "react";
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
import "../../features/calls/calls.css";

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { safeMode, safeModeReason, disableSafeMode } = useMotionMode();
  const lastOpenedThreadRef = useRef("");
  const {
    closeSidebar,
    expandSidebar,
    isSidebarCollapsed
  } = useShell();
  const fullCanvasAdmin = location.pathname.startsWith("/admin/live-pages");
  const isChatWorkspace = location.pathname.startsWith("/chat");

  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, location.pathname]);

  useEffect(() => {
    const openChatThread = (event: Event) => {
      const rawDetail = event instanceof CustomEvent ? event.detail : null;
      try {
        const detail = typeof rawDetail === "string" ? JSON.parse(rawDetail) : rawDetail;
        const threadId = typeof detail?.threadId === "string" ? detail.threadId.trim() : "";
        if (!threadId) return;
        const encodedThreadId = encodeURIComponent(threadId);
        if (lastOpenedThreadRef.current === threadId && location.pathname.endsWith(`/${encodedThreadId}`)) return;
        lastOpenedThreadRef.current = threadId;
        navigate(`/messages/${encodedThreadId}`, { replace: location.pathname.startsWith("/messages/") });
      } catch {
        return;
      }
    };
    window.addEventListener("auto-ai-open-chat-thread", openChatThread);
    return () => window.removeEventListener("auto-ai-open-chat-thread", openChatThread);
  }, [location.pathname, navigate]);

  return (
      <CallProvider>
          <ChatProvider>
          <AndroidBackHandler />
          <div className="app-shell">
            {!fullCanvasAdmin && <WorkspaceNavigation />}
            {!fullCanvasAdmin && isChatWorkspace && <Sidebar />}
            {!fullCanvasAdmin && isChatWorkspace && isSidebarCollapsed && (
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
              <div className="route-transition-stage" key={`${location.pathname}${location.search}`}>
                <Outlet />
              </div>
            </main>
            {!fullCanvasAdmin && <WorkspaceMobileNavigation />}
            <CallOverlay />
          </div>
          </ChatProvider>
      </CallProvider>
  );
}
