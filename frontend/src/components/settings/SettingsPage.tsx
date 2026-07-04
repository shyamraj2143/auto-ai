import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import clsx from "clsx";
import {
  ArrowLeft,
  Bell,
  BrainCircuit,
  Globe2,
  LockKeyhole,
  LogOut,
  Mail,
  Mic,
  Monitor,
  Moon,
  Radio,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserCircle2,
  type LucideIcon
} from "lucide-react";
import { api } from "../../api/client";
import {
  PROVIDER_MODELS,
  useAppSettings,
  type AiProvider,
  type AppLanguage
} from "../../contexts/AppSettingsContext";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useTheme } from "../../contexts/ThemeContext";
import type { ResearchProvider } from "../../types";
import { SubscriptionBillingCenter } from "./SubscriptionBillingCenter";

const APP_VERSION = "1.0.0";

const THEME_OPTIONS: Array<{ value: "light" | "dark" | "system"; label: string; icon: LucideIcon }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor }
];

const LANGUAGE_OPTIONS: Array<{ value: AppLanguage; label: string }> = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
  { value: "hinglish", label: "Hinglish" }
];

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  groq: "Groq",
  bedrock: "AWS Bedrock"
};

function SettingsIcon({ icon: Icon, accent = "cyan" }: { icon: LucideIcon; accent?: "cyan" | "violet" | "amber" | "green" | "rose" | "red" }) {
  return (
    <span
      className={clsx(
        "grid h-9 w-9 shrink-0 place-items-center rounded-md border",
        accent === "cyan" && "border-cyan-200/15 bg-cyan-200/10 text-cyan-200",
        accent === "violet" && "border-violet-200/15 bg-violet-200/10 text-violet-200",
        accent === "amber" && "border-amber-200/15 bg-amber-200/10 text-amber-200",
        accent === "green" && "border-emerald-200/15 bg-emerald-200/10 text-emerald-200",
        accent === "rose" && "border-rose-200/15 bg-rose-200/10 text-rose-200",
        accent === "red" && "border-red-200/15 bg-red-200/10 text-red-200"
      )}
    >
      <Icon size={18} />
    </span>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] shadow-[0_22px_60px_rgba(0,0,0,0.24)] backdrop-blur-xl">
      {children}
    </section>
  );
}

function SettingsRow({
  icon,
  accent,
  title,
  description,
  children
}: {
  icon: LucideIcon;
  accent?: "cyan" | "violet" | "amber" | "green" | "rose" | "red";
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b border-white/10 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <SettingsIcon icon={icon} accent={accent} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{title}</p>
          {description && <p className="mt-0.5 truncate text-xs text-slate-400">{description}</p>}
        </div>
      </div>
      {children && <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:shrink-0">{children}</div>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={clsx(
        "relative inline-flex h-7 w-12 items-center rounded-full border transition disabled:opacity-50",
        checked ? "border-cyan-200/40 bg-cyan-200/20" : "border-white/15 bg-white/10"
      )}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      aria-pressed={checked}
    >
      <span
        className={clsx(
          "block h-5 w-5 rounded-full bg-white transition",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}

function Select({
  value,
  onChange,
  children,
  disabled,
  label
}: {
  value: string | number;
  onChange: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      className="h-9 max-w-[44vw] rounded-md border border-white/10 bg-slate-950/80 px-2 text-xs font-semibold text-cyan-50 outline-none transition focus:border-cyan-200/60 focus:ring-2 focus:ring-cyan-200/15 disabled:opacity-50 md:max-w-none"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {children}
    </select>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { token, user, logout } = useAuth();
  const { chats, refreshChats, setActiveChat } = useChat();
  const { theme, setTheme } = useTheme();
  const {
    settings,
    setDefaultProvider,
    setDefaultModel,
    setMemoryEnabled,
    setStreamingEnabled,
    setVoiceEnabled,
    setNotificationsEnabled,
    setLanguage,
    setDeepResearchProviders,
    setDeepResearchMaxModels,
    setDeepResearchAllModels,
    setDeepResearchTimeoutSeconds
  } = useAppSettings();
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [isClearingChats, setIsClearingChats] = useState(false);

  const providerModels = useMemo(
    () => PROVIDER_MODELS[settings.defaultProvider],
    [settings.defaultProvider]
  );
  const selectedModelLabel = providerModels.find((item) => item.value === settings.defaultModel)?.label ?? settings.defaultModel;
  const accountCreated = user?.created_at ? new Date(user.created_at).toLocaleDateString() : "Unknown";

  useEffect(() => {
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
  }, []);

  function goBack() {
    try {
      const result = (location.key === "default" ? navigate("/chat") : navigate(-1)) as void | Promise<void>;
      if (result && typeof result.catch === "function") {
        void result.catch((error: unknown) => {
          console.error("[Auto-AI Navigation] Failed to leave settings.", error);
        });
      }
    } catch (error) {
      console.error("[Auto-AI Navigation] Failed to leave settings.", error);
      navigate("/chat");
    }
  }

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

  async function updateNotifications(enabled: boolean) {
    if (!enabled) {
      setNotificationsEnabled(false);
      return;
    }
    if (!("Notification" in window)) {
      console.warn("[Auto-AI Notifications] Notifications are not supported in this browser.");
      setNotificationsEnabled(false);
      setNotificationPermission("unsupported");
      return;
    }
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    setNotificationPermission(permission);
    if (permission === "granted") {
      setNotificationsEnabled(true);
      return;
    }
    console.warn("[Auto-AI Notifications] Notification permission was not granted.");
    setNotificationsEnabled(false);
  }

  function toggleResearchProvider(provider: ResearchProvider) {
    const current = settings.deepResearchProviders;
    const next = current.includes(provider)
      ? current.filter((item) => item !== provider)
      : [...current, provider];
    if (next.length) setDeepResearchProviders(next);
  }

  function updateProvider(value: string) {
    if (value === "openai" || value === "groq" || value === "bedrock") {
      setDefaultProvider(value);
    }
  }

  return (
    <motion.div
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-white md:px-6 md:py-5"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
    >
      <div className="mx-auto w-full max-w-6xl pb-8">
        <header className="sticky top-0 z-20 -mx-3 mb-3 flex h-12 items-center justify-between border-b border-white/10 bg-slate-950/80 px-4 backdrop-blur-xl md:static md:mx-0 md:h-auto md:rounded-lg md:border md:bg-white/[0.04] md:px-4 md:py-4">
          <button className="icon-button-dark" type="button" onClick={goBack} title="Back">
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-sm font-semibold md:text-lg">Settings</h1>
          <span className="h-9 w-9" />
        </header>

        <div className="grid gap-3">
          <SettingsCard>
            <SettingsRow
              icon={UserCircle2}
              title="Profile"
              description={`${user?.name ?? "Account"}${user?.mobile ? ` - ${user.mobile}` : ""}`}
            />
            <SettingsRow
              icon={Mail}
              accent="violet"
              title="Account"
              description={`${user?.email ?? "Unknown email"} - Joined ${accountCreated}`}
            />
          </SettingsCard>

          <SettingsCard>
            <SettingsRow icon={Sun} accent="amber" title="Theme" description="Light / Dark / System">
              <div className="grid grid-cols-3 gap-1 rounded-md border border-white/10 bg-slate-950/70 p-1">
                {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    className={clsx(
                      "inline-flex h-8 items-center justify-center gap-1 rounded px-2 text-[11px] font-semibold transition",
                      theme === value ? "bg-cyan-200/15 text-cyan-100" : "text-slate-400 hover:bg-white/10 hover:text-white"
                    )}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard>
            <SettingsRow
              icon={BrainCircuit}
              accent="cyan"
              title="AI Model Preferences"
              description={`${PROVIDER_LABELS[settings.defaultProvider]} - ${selectedModelLabel}`}
            >
              <Select value={settings.defaultProvider} onChange={updateProvider} label="Default AI provider">
                {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select value={settings.defaultModel} onChange={setDefaultModel} label="Default AI model">
                {providerModels.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>
            <SettingsRow
              icon={SlidersHorizontal}
              accent="green"
              title="Deep Research Settings"
              description={`${settings.deepResearchAllModels ? "All models" : `${settings.deepResearchMaxModels} model limit`} - ${settings.deepResearchTimeoutSeconds}s timeout`}
            >
              <div className="hidden items-center gap-1 sm:flex">
                {(["groq", "bedrock"] as ResearchProvider[]).map((provider) => (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => toggleResearchProvider(provider)}
                    className={clsx(
                      "h-8 rounded-md border px-2 text-[11px] font-semibold transition",
                      settings.deepResearchProviders.includes(provider)
                        ? "border-cyan-200/35 bg-cyan-200/12 text-cyan-50"
                        : "border-white/10 bg-white/5 text-slate-400"
                    )}
                  >
                    {PROVIDER_LABELS[provider]}
                  </button>
                ))}
              </div>
              <Select
                value={settings.deepResearchMaxModels}
                onChange={(value) => setDeepResearchMaxModels(Number(value))}
                disabled={settings.deepResearchAllModels}
                label="Max deep research models"
              >
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value} value={value}>
                    Max {value}
                  </option>
                ))}
              </Select>
              <Select
                value={settings.deepResearchTimeoutSeconds}
                onChange={(value) => setDeepResearchTimeoutSeconds(Number(value))}
                label="Deep research timeout"
              >
                {[20, 35, 45, 60, 90, 120].map((value) => (
                  <option key={value} value={value}>
                    {value}s
                  </option>
                ))}
              </Select>
            </SettingsRow>
            <SettingsRow icon={Sparkles} accent="violet" title="Use all deep research models" description="Overrides the max model limit">
              <Toggle checked={settings.deepResearchAllModels} onChange={setDeepResearchAllModels} />
            </SettingsRow>
          </SettingsCard>

          <SettingsCard>
            <SettingsRow
              icon={Bell}
              accent="rose"
              title="Notifications"
              description={notificationPermission === "unsupported" ? "Not supported on this device" : `Permission: ${notificationPermission}`}
            >
              <Toggle
                checked={settings.notificationsEnabled}
                onChange={(checked) => void updateNotifications(checked)}
                disabled={notificationPermission === "unsupported"}
              />
            </SettingsRow>
            <SettingsRow icon={Globe2} title="Language" description="Sets the app language metadata">
              <Select value={settings.language} onChange={(value) => setLanguage(value as AppLanguage)} label="Language">
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>
          </SettingsCard>

          <SubscriptionBillingCenter />

          <SettingsCard>
            <SettingsRow icon={LockKeyhole} accent="green" title="Privacy & Security" description="Memory and data controls" />
            <SettingsRow icon={Shield} title="Memory" description="Use saved memory and selected context in chat requests">
              <Toggle checked={settings.memoryEnabled} onChange={setMemoryEnabled} />
            </SettingsRow>
            <SettingsRow icon={Radio} accent="cyan" title="Streaming" description="Stream model responses as they are generated">
              <Toggle checked={settings.streamingEnabled} onChange={setStreamingEnabled} />
            </SettingsRow>
            <SettingsRow icon={Mic} accent="violet" title="Voice Input" description="Show microphone controls in the composer">
              <Toggle checked={settings.voiceEnabled} onChange={setVoiceEnabled} />
            </SettingsRow>
            <SettingsRow icon={Trash2} accent="red" title="Clear Chats" description={`${chats.length} saved chat${chats.length === 1 ? "" : "s"}`}>
              <button
                className="btn-secondary h-9 px-3 text-xs"
                type="button"
                onClick={clearAllChats}
                disabled={isClearingChats || chats.length === 0}
              >
                <Trash2 size={14} />
                {isClearingChats ? "Clearing" : "Clear"}
              </button>
            </SettingsRow>
          </SettingsCard>

          <SettingsCard>
            <button
              className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left transition hover:bg-red-500/10"
              type="button"
              onClick={logout}
            >
              <SettingsIcon icon={LogOut} accent="red" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-red-200">Logout</span>
                <span className="mt-0.5 block truncate text-xs text-slate-400">Sign out from your account</span>
              </span>
            </button>
          </SettingsCard>

          <SettingsCard>
            <SettingsRow icon={Monitor} title="App Version" description="Installed frontend build">
              <span className="text-xs font-semibold text-slate-300">v{APP_VERSION}</span>
            </SettingsRow>
          </SettingsCard>
        </div>
      </div>

    </motion.div>
  );
}
