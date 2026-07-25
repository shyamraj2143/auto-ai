import { Bell, Home, LogOut, Search, Settings2, TimerReset } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import type { User } from "../../types";
import { LogoIcon } from "../../components/brand/LogoIcon";

function userAvatar(user: User) {
  return resolveApiAssetUrl(user.picture || user.avatar);
}

export function HubHeader({
  user,
  unreadNotifications,
  onOpenQuickConnect,
  onLogout,
}: {
  user: User;
  unreadNotifications: number;
  onOpenQuickConnect: () => void;
  onLogout: () => Promise<void>;
}) {
  const avatar = userAvatar(user);
  const initial = user.name.trim().slice(0, 1).toUpperCase() || "A";

  return (
    <header className="hub-header">
      <Link className="hub-brand" to="/hub" aria-label="AutoAI Action Hub">
        <LogoIcon loading="eager" />
        <strong>AutoAI</strong>
      </Link>

      <nav className="hub-desktop-nav" aria-label="Action Hub navigation">
        <NavLink to="/hub"><Home size={15} /> Home</NavLink>
        <NavLink to="/activity"><TimerReset size={15} /> Activity</NavLink>
      </nav>

      <button className="hub-command-search" type="button" onClick={onOpenQuickConnect} aria-label="Open Quick Connect">
        <Search size={18} />
        <span>Search or type a command...</span>
        <kbd>⌘ K</kbd>
      </button>

      <div className="hub-header-actions">
        <Link className="hub-header-icon" to="/calls?view=notifications" aria-label="Open notifications">
          <Bell size={19} />
          {unreadNotifications > 0 && <span>{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}
        </Link>
        <Link className="hub-header-icon hub-settings-link" to="/settings" aria-label="Open settings">
          <Settings2 size={19} />
        </Link>
        <Link className="hub-profile-link" to="/settings?section=general" aria-label="Open profile">
          <span className="hub-avatar">{avatar ? <img src={avatar} alt="" /> : initial}</span>
          <span className="hub-profile-status"><strong>{user.name}</strong><small><i /> Connected</small></span>
        </Link>
        <button className="hub-header-icon hub-logout" type="button" onClick={() => void onLogout()} aria-label="Logout">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
