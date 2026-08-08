import {
  BarChart3,
  AlarmClock,
  BriefcaseBusiness,
  FileCheck2,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  MessagesSquare,
  MonitorUp,
  Phone,
  Settings,
  UsersRound,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { isAdminPanelRole } from "../../utils/roles";
import { LogoIcon } from "../brand/LogoIcon";
import "./workspaceNavigation.css";

const primaryItems = [
  { to: "/hub", label: "Dashboard", icon: LayoutDashboard },
  { to: "/chat", label: "AI Chat", icon: MessageCircle },
  { to: "/seva", label: "AutoAI Seva", icon: FileCheck2 },
  { to: "/screen-share", label: "Screen Sharing", icon: MonitorUp },
  { to: "/call-hub/calls", label: "Calls", icon: Phone },
  { to: "/messages", label: "Messages", icon: MessagesSquare },
  { to: "/alarms", label: "AI Alarm", icon: AlarmClock },
  { to: "/call-hub/chats", label: "Contacts", icon: UsersRound },
  { to: "/activity", label: "Analytics", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

const sevaOperationsItem = { to: "/admin/seva-operations", label: "Seva Operations", icon: BriefcaseBusiness } as const;

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase() || "A";
}

export function WorkspaceNavigation() {
  const { user, logout } = useAuth();
  if (!user) return null;
  const avatar = resolveApiAssetUrl(user.avatar || user.picture);
  const items = user.role === "seva_agent" ? [sevaOperationsItem] : isAdminPanelRole(user.role) && user.is_admin
    ? [...primaryItems.slice(0, 3), sevaOperationsItem, ...primaryItems.slice(3)]
    : primaryItems;

  return (
    <aside className="autoai-workspace-nav" aria-label="AutoAI workspace">
      <NavLink className="autoai-workspace-brand" to="/hub" aria-label="AutoAI Dashboard">
        <LogoIcon loading="eager" />
        <strong>AutoAI</strong>
      </NavLink>
      <nav>
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => isActive ? "active" : undefined}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="autoai-workspace-profile">
        <span className="autoai-workspace-avatar">
          {avatar ? <img src={avatar} alt="" /> : initials(user.name || user.email)}
        </span>
        <span>
          <strong>{user.name || "AutoAI User"}</strong>
          <small>{user.role === "seva_agent" ? `Agent ID: ${user.username}` : user.email}</small>
        </span>
        <button type="button" onClick={logout} aria-label="Sign out" title="Sign out">
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  );
}

export function WorkspaceMobileNavigation() {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.is_admin && isAdminPanelRole(user.role));
  const mobileItems = user?.role === "seva_agent" ? [sevaOperationsItem] : isAdmin
    ? [primaryItems[0], primaryItems[2], sevaOperationsItem, primaryItems[4], primaryItems[5]]
    : primaryItems.slice(0, 5);

  return (
    <nav className="autoai-mobile-nav" aria-label="Primary navigation">
      {mobileItems.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} className={({ isActive }) => isActive ? "active" : undefined}>
          <Icon size={21} />
          <span>{label === "Screen Sharing" ? "Share" : label === "AutoAI Seva" ? "Seva" : label === "Seva Operations" ? "Work" : label}</span>
        </NavLink>
      ))}
      <NavLink to="/settings" className={({ isActive }) => isActive ? "active autoai-mobile-more" : "autoai-mobile-more"}>
        <Settings size={21} />
        <span>More</span>
      </NavLink>
    </nav>
  );
}
