import { Bell, Download, Home, LogOut, Search, Settings2, TimerReset } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import type { User } from "../../types";
import { LogoIcon } from "../../components/brand/LogoIcon";
import { isNativeAndroid, NativeUpdate, shouldShowUpdate, updateButtonBusy, updateButtonLabel, type NativeUpdateState } from "./nativeUpdate";

function userAvatar(user: User) {
  return resolveApiAssetUrl(user.picture || user.avatar);
}

export function HubHeader({
  user,
  unreadNotifications,
  notificationHref = "/call-hub/alerts",
  onOpenQuickConnect,
  onLogout,
}: {
  user: User;
  unreadNotifications: number;
  notificationHref?: string;
  onOpenQuickConnect: () => void;
  onLogout: () => Promise<void>;
}) {
  const avatar = userAvatar(user);
  const initial = user.name.trim().slice(0, 1).toUpperCase() || "A";
  const [updateState, setUpdateState] = useState<NativeUpdateState | null>(null);

  useEffect(() => {
    if (!isNativeAndroid()) return;
    let active = true;
    let listener: { remove: () => Promise<void> } | undefined;
    const apply = (state: NativeUpdateState) => {
      if (active) setUpdateState(state);
    };
    const refresh = () => {
      void NativeUpdate.getState().then(apply).catch(() => undefined);
      void NativeUpdate.checkForUpdate().then(apply).catch(() => undefined);
    };
    void NativeUpdate.addListener("stateChanged", apply).then((handle) => {
      if (active) listener = handle;
      else void handle.remove();
    });
    refresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void listener?.remove();
    };
  }, []);

  const startUpdate = async () => {
    if (updateButtonBusy(updateState)) return;
    setUpdateState(await NativeUpdate.startDirectUpdate());
  };

  return (
    <header className="hub-header">
      <div className="hub-brand-row">
        <Link className="hub-brand" to="/hub" aria-label="AutoAI Action Hub">
          <LogoIcon loading="eager" />
          <strong>AutoAI</strong>
        </Link>
        {shouldShowUpdate(updateState) && (
          <button className={`hub-update-button hub-update-${updateState?.state.toLowerCase() ?? "available"}`} type="button" disabled={updateButtonBusy(updateState)} onClick={() => void startUpdate()} aria-label={updateState?.message || updateButtonLabel(updateState)} title={updateState?.state === "FAILED" ? updateState.message : undefined}>
            <Download size={15} /><span>{updateButtonLabel(updateState)}</span><i aria-hidden="true" />
            {updateState?.state === "DOWNLOADING" && <b aria-hidden="true" style={{ width: `${updateState.progress ?? 0}%` }} />}
          </button>
        )}
      </div>

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
        <Link className="hub-header-icon" to={notificationHref} aria-label="Open notifications">
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
