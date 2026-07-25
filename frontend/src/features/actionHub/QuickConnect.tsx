import { Bot, Hash, Mic, Video, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validateQuickConnect } from "./actionHubNavigation";

export type QuickConnectAction = "ai" | "screen" | "voice" | "video";

const ACTIONS = [
  { id: "ai" as const, label: "AI command", icon: Bot },
  { id: "screen" as const, label: "Join screen", icon: Hash },
  { id: "voice" as const, label: "Voice call", icon: Mic },
  { id: "video" as const, label: "Video call", icon: Video },
];

export function QuickConnect({ open, initialAction = "ai", onClose, onAiCommand, onJoinScreen, onFindContact }: {
  open: boolean;
  initialAction?: QuickConnectAction;
  onClose: () => void;
  onAiCommand: (command: string) => void;
  onJoinScreen: (code: string) => Promise<void>;
  onFindContact: (query: string, type: "audio" | "video") => void;
}) {
  const [action, setAction] = useState<QuickConnectAction>(initialAction);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setAction(initialAction);
    setValue("");
    setError("");
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [initialAction, onClose, open]);

  if (!open) return null;

  const placeholder = action === "ai"
    ? "Ask AutoAI anything…"
    : action === "screen"
      ? "Enter 8 digit sharing code"
      : "Search name or username";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const result = validateQuickConnect(action, value);
    if (!result.valid) {
      setError(result.error);
      return;
    }
    if (action === "screen") {
      setBusy(true);
      try {
        await onJoinScreen(result.value);
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (action === "ai") {
      onAiCommand(result.value);
      onClose();
      return;
    }
    onFindContact(result.value, action === "voice" ? "audio" : "video");
    onClose();
  }

  return (
    <div className="hub-quick-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="hub-quick-panel" role="dialog" aria-modal="true" aria-labelledby="hub-quick-title">
        <header><span><Zap /><strong id="hub-quick-title">Quick Connect</strong></span><button type="button" onClick={onClose} aria-label="Close Quick Connect"><X /></button></header>
        <div className="hub-quick-tabs" role="tablist" aria-label="Quick Connect action">
          {ACTIONS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={action === id} onClick={() => { setAction(id); setValue(""); setError(""); }}>
              <Icon />{label}
            </button>
          ))}
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="hub-quick-input">{ACTIONS.find((item) => item.id === action)?.label}</label>
          <div className="hub-quick-input-row">
            <input
              ref={inputRef}
              id="hub-quick-input"
              value={value}
              onChange={(event) => setValue(action === "screen" ? event.target.value.replace(/\D/g, "").slice(0, 8) : event.target.value)}
              placeholder={placeholder}
              inputMode={action === "screen" ? "numeric" : "text"}
              autoComplete="off"
              maxLength={action === "screen" ? 8 : action === "ai" ? 2000 : 80}
            />
            <button type="submit" disabled={busy}>{busy ? "Connecting…" : "Continue"}</button>
          </div>
          {error && <p role="alert">{error}</p>}
          <small>{action === "voice" || action === "video" ? "You will choose a permitted contact before the call starts." : action === "screen" ? "The existing secure screen-sharing service will handle the connection." : "Your command will open in the existing AI Chat composer."}</small>
        </form>
      </section>
    </div>
  );
}
