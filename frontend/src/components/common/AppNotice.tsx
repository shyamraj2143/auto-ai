import { useEffect, useState } from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import clsx from "clsx";

type AppNoticeProps = {
  message: string;
  kind?: "info" | "error";
  onRetry?: () => void;
  onDismiss?: () => void;
};

const OFFLINE_MESSAGE = "No internet connection. Turn on mobile data or Wi-Fi, then retry.";

export function AppNotice({ message, kind = "info", onRetry, onDismiss }: AppNoticeProps) {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  const visibleMessage = kind === "error" && !online ? OFFLINE_MESSAGE : message;
  return (
    <div className={clsx("app-notice", `app-notice-${kind}`)} role={kind === "error" ? "alert" : "status"} aria-live={kind === "error" ? "assertive" : "polite"}>
      {kind === "error" ? <AlertTriangle size={16} /> : <Info size={16} />}
      <span>{visibleMessage}</span>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
      {onDismiss && <button type="button" className="app-notice-dismiss" onClick={onDismiss} aria-label="Dismiss notice"><X size={14} /></button>}
    </div>
  );
}
