import { Link, useLocation } from "react-router-dom";
import { LogOut, Moon, Settings, Shield, Sun, Zap } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useShell } from "../../contexts/ShellContext";
import { useTheme } from "../../contexts/ThemeContext";

export function Header() {
  const { logout, user } = useAuth();
  const { resolvedTheme, toggleTheme } = useTheme();
  const { openSettings } = useShell();
  const location = useLocation();

  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const isChatWorkspace = normalizedPath === "/chat" || normalizedPath === "/";

  return (
    <header
      className={clsx(
        "h-14 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/70 px-4 text-white backdrop-blur-xl",
        isChatWorkspace ? "hidden md:flex" : "flex"
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
        <button className="icon-button-dark" onClick={openSettings} title="Settings" aria-label="Open settings" type="button">
          <Settings size={18} />
        </button>
        {user?.is_admin && (
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
