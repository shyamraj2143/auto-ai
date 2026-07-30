import { AlertTriangle, Info, X } from "lucide-react";
import clsx from "clsx";

type AppNoticeProps = {
  message: string;
  kind?: "info" | "error";
  onRetry?: () => void;
  onDismiss?: () => void;
};

export function AppNotice({ message, kind = "info", onRetry, onDismiss }: AppNoticeProps) {
  return (
    <div className={clsx("app-notice", `app-notice-${kind}`)} role={kind === "error" ? "alert" : "status"} aria-live={kind === "error" ? "assertive" : "polite"}>
      {kind === "error" ? <AlertTriangle size={16} /> : <Info size={16} />}
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
      {onDismiss && <button type="button" className="app-notice-dismiss" onClick={onDismiss} aria-label="Dismiss notice"><X size={14} /></button>}
    </div>
  );
}
