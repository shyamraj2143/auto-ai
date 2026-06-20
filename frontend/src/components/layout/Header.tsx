import { Link } from "react-router-dom";
import { LogOut, Moon, Shield, Sun, Zap } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";

export function Header() {
  const { logout, user } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/70 px-4 text-white backdrop-blur-xl">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 truncate text-sm font-semibold">
          <Zap size={15} className="text-cyan-200" />
          Auto-AI Workspace
        </h2>
        <p className="truncate text-xs text-slate-400">{user?.email}</p>
      </div>
      <div className="flex items-center gap-2">
        {user?.is_admin && (
          <Link className="icon-button-dark" to="/admin" title="Admin dashboard">
            <Shield size={18} />
          </Link>
        )}
        <button className="icon-button-dark" onClick={toggleTheme} title="Toggle theme">
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="icon-button-dark" onClick={logout} title="Logout">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
