import { AnimatePresence, motion } from "framer-motion";
import { Cpu, LogOut, Monitor, Moon, Power, Sun, Trash2, User, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { api } from "../../api/client";
import {
  PROVIDER_MODELS,
  useAppSettings,
  type AiProvider
} from "../../contexts/AppSettingsContext";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useTheme } from "../../contexts/ThemeContext";

const APP_VERSION = "1.0.0";

type AppearanceTheme = "light" | "dark" | "system";

const THEME_OPTIONS: Array<{ value: AppearanceTheme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor }
];

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  bedrock: "Bedrock"
};

function ToggleRow({
  title,
  description,
  enabled,
  onChange
}: {
  title: string;
  description: string;
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{title}</p>
        <p className="text-xs text-slate-400">{description}</p>
      </div>
      <button
        type="button"
        className={clsx(
          "relative inline-flex h-7 w-12 items-center rounded-full border transition",
          enabled ? "border-cyan-200/40 bg-cyan-200/20" : "border-white/15 bg-white/10"
        )}
        onClick={() => onChange(!enabled)}
        aria-pressed={enabled}
      >
        <span
          className={clsx(
            "block h-5 w-5 rounded-full bg-white transition",
            enabled ? "translate-x-6" : "translate-x-1"
          )}
        />
      </button>
    </div>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { token, user, logout } = useAuth();
  const { chats, refreshChats, setActiveChat } = useChat();
  const { theme, setTheme } = useTheme();
  const {
    settings,
    setDefaultProvider,
    setDefaultModel,
    setMemoryEnabled,
    setStreamingEnabled,
    setVoiceEnabled
  } = useAppSettings();
  const [isClearingChats, setIsClearingChats] = useState(false);

  const models = useMemo(() => PROVIDER_MODELS[settings.defaultProvider], [settings.defaultProvider]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  async function clearAllChats() {
    if (!token || !chats.length || !window.confirm("Clear all chats? This action cannot be undone.")) return;
    setIsClearingChats(true);
    try {
      await Promise.allSettled(chats.map((chat) => api.deleteChat(token, chat.id)));
      setActiveChat(null);
      await refreshChats();
    } finally {
      setIsClearingChats(false);
    }
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 px-3 py-4 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.section
            className="relative flex h-[min(720px,calc(100vh-2rem))] w-[min(100%,840px)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 text-white shadow-[0_28px_90px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            initial={{ y: 24, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 14, scale: 0.98, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-white/10 px-4 py-4 md:px-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-300/80">Settings</p>
                <h3 id="settings-title" className="text-base font-semibold md:text-lg">Workspace Preferences</h3>
              </div>
              <button className="icon-button-dark" onClick={onClose} type="button" title="Close settings">
                <X size={16} />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
                <h4 className="mb-3 text-sm font-semibold text-white">Theme</h4>
                <div className="grid gap-3 sm:grid-cols-3">
                  {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
                    const active = theme === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setTheme(value)}
                        className={clsx(
                          "flex h-20 items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition",
                          active
                            ? "border-cyan-200/30 bg-cyan-200/12 text-cyan-50"
                            : "border-white/10 bg-slate-900/40 text-slate-300 hover:border-white/20"
                        )}
                      >
                        <Icon size={16} />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
                <h4 className="mb-3 text-sm font-semibold text-white">AI Configuration</h4>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="text-slate-300">AI Provider</span>
                    <select
                      value={settings.defaultProvider}
                      onChange={(event) => setDefaultProvider(event.target.value as AiProvider)}
                      className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none transition focus:border-cyan-200/40"
                    >
                      {(Object.keys(PROVIDER_LABELS) as AiProvider[]).map((provider) => (
                        <option key={provider} value={provider} className="bg-slate-950 text-white">
                          {PROVIDER_LABELS[provider]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-2 text-sm">
                    <span className="text-slate-300">Default Model</span>
                    <select
                      value={settings.defaultModel}
                      onChange={(event) => setDefaultModel(event.target.value)}
                      className="h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none transition focus:border-cyan-200/40"
                    >
                      {models.map((model) => (
                        <option key={model.value} value={model.value} className="bg-slate-950 text-white">
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              <section className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
                <h4 className="text-sm font-semibold text-white">Features</h4>
                <ToggleRow
                  title="Memory"
                  description="Use saved memory and selected context in chat requests."
                  enabled={settings.memoryEnabled}
                  onChange={setMemoryEnabled}
                />
                <ToggleRow
                  title="Streaming"
                  description="Stream model responses token-by-token while they are generated."
                  enabled={settings.streamingEnabled}
                  onChange={setStreamingEnabled}
                />
                <ToggleRow
                  title="Voice"
                  description="Show voice input in the composer."
                  enabled={settings.voiceEnabled}
                  onChange={setVoiceEnabled}
                />
              </section>

              <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 md:p-5">
                <h4 className="mb-3 text-sm font-semibold text-white">Data & Account</h4>
                <div className="grid gap-3 md:grid-cols-2">
                  <button className="btn-secondary justify-center" type="button" onClick={clearAllChats} disabled={isClearingChats || chats.length === 0}>
                    <Trash2 size={16} />
                    {isClearingChats ? "Clearing chats..." : "Clear Chats"}
                  </button>
                  <button className="btn-secondary justify-center" type="button" onClick={logout}>
                    <LogOut size={16} />
                    Logout
                  </button>
                </div>
                <div className="mt-4 grid gap-2 rounded-xl border border-white/10 bg-slate-950/45 p-3 text-xs text-slate-300">
                  <p className="flex items-center gap-2"><User size={14} /> {user?.email ?? "Unknown account"}</p>
                  <p className="flex items-center gap-2"><Cpu size={14} /> Provider: {PROVIDER_LABELS[settings.defaultProvider]}</p>
                  <p className="flex items-center gap-2"><Power size={14} /> App Version: {APP_VERSION}</p>
                </div>
              </section>
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
