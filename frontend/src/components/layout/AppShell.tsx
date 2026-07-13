import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PanelLeftOpen } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { AppSettingsProvider } from "../../contexts/AppSettingsContext";
import { ChatProvider } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { CallProvider } from "../../features/calls/CallProvider";
import { CallOverlay } from "../../features/calls/CallOverlay";
import { useMotionMode } from "../../motion/MotionProvider";
import { motionDurations, motionEase } from "../../motion/tokens";
import "../../features/calls/calls.css";

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const lastOpenedThreadRef = useRef("");
  const {
    closeSidebar,
    expandSidebar,
    isSidebarCollapsed
  } = useShell();
  const { enabled, reduceMotion } = useMotionMode();

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
    <AppSettingsProvider>
      <CallProvider>
        <ChatProvider>
          <div className="app-shell">
            <Sidebar />
            {isSidebarCollapsed && (
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
              <Header />
              {enabled && !reduceMotion ? (
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={location.pathname}
                    className="route-transition-stage"
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -6 }}
                    transition={{ duration: motionDurations.page, ease: motionEase.standard }}
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              ) : (
                <Outlet />
              )}
            </main>
            <CallOverlay />
          </div>
        </ChatProvider>
      </CallProvider>
    </AppSettingsProvider>
  );
}
