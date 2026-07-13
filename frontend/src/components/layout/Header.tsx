import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bot, Brain, LogOut, Moon, PhoneCall, Settings, Shield, Sun, Zap } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { useSettingsNavigation } from "../../hooks/useSettingsNavigation";
import { useCallSession } from "../../features/calls/hooks/useCallSession";
import { FishAnimationToggleButton } from "./FishAnimationToggleButton";

export function Header() {
  const { logout, user } = useAuth();
  const { resolvedTheme, toggleTheme } = useTheme();
  const openSettings = useSettingsNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const { config: callConfig } = useCallSession();

  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const isChatWorkspace = normalizedPath === "/chat" || normalizedPath === "/";
  const isSettingsWorkspace = normalizedPath === "/settings";
  const isCallsWorkspace = normalizedPath === "/calls";

  function openContextPanel(tab: "documents" | "memory") {
    const event = () => window.dispatchEvent(new CustomEvent("open-context-panel", { detail: { tab } }));
    if (isChatWorkspace) {
      event();
      return;
    }
    try {
      const result = navigate("/chat") as void | Promise<void>;
      if (result && typeof result.catch === "function") {
        void result
          .then(() => window.setTimeout(event, 60))
          .catch((error: unknown) => {
            console.error("[Auto-AI Navigation] Failed to open context panel.", error);
          });
        return;
      }
      window.setTimeout(event, 60);
    } catch (error) {
      console.error("[Auto-AI Navigation] Failed to open context panel.", error);
    }
  }

  return (
    <header
      className={clsx(
        "workspace-header h-14 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/70 px-4 text-white backdrop-blur-xl",
        isChatWorkspace || isSettingsWorkspace || isCallsWorkspace ? "hidden md:flex" : "flex"
      )}
    >
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
          <Zap size={15} className="text-cyan-200" />
          Auto-AI Workspace
        </h2>
        <p className="truncate text-xs text-slate-400">{user?.email}</p>
      </div>
      <div className="flex items-center gap-2">
        <FishAnimationToggleButton />
        <button
          className="icon-button-dark"
          onClick={() => openContextPanel("documents")}
          title="Context"
          aria-label="Open context"
          type="button"
        >
          <Bot size={18} />
        </button>
        <button
          className="icon-button-dark"
          onClick={() => openContextPanel("memory")}
          title="Memory"
          aria-label="Open memory"
          type="button"
        >
          <Brain size={18} />
        </button>
        {callConfig?.enabled !== false && <button
          className="icon-button-dark"
          onClick={() => navigate("/calls")}
          title="Calls"
          aria-label="Open calls"
          type="button"
        >
          <PhoneCall size={18} />
        </button>}
        <button
          className="icon-button-dark"
          onClick={openSettings}
          title="Settings"
          aria-label="Open settings"
          type="button"
        >
          <Settings size={18} />
        </button>
        {(user?.role === "admin" || user?.role === "super_admin") && (
          <Link className="icon-button-dark" to="/admin" title="Admin dashboard">
            <Shield size={18} />
          </Link>
        )}
        <button className="icon-button-dark" onClick={toggleTheme} title="Toggle theme">
          {resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="icon-button-dark" onClick={logout} title="Logout">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
