import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AppSettingsProvider } from "../../contexts/AppSettingsContext";
import { ChatProvider } from "../../contexts/ChatContext";
import { useShell } from "../../contexts/ShellContext";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const location = useLocation();
  const {
    closeSidebar
  } = useShell();

  useEffect(() => {
    closeSidebar();
  }, [closeSidebar, location.pathname]);

  return (
    <AppSettingsProvider>
      <ChatProvider>
        <div className="app-shell">
          <Sidebar />
          <main className="flex min-w-0 flex-1 flex-col">
            <Header />
            <Outlet />
          </main>
        </div>
      </ChatProvider>
    </AppSettingsProvider>
  );
}
