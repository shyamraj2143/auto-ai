import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import {
  ArrowLeft,
  Bell,
  Bot,
  BrainCircuit,
  CheckCheck,
  ChevronRight,
  CreditCard,
  Globe2,
  LockKeyhole,
  LogOut,
  Mic,
  MessageCircle,
  Monitor,
  Moon,
  Radio,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  PhoneCall,
  Gem,
  AudioLines,
  CircleDot,
  MousePointer2,
  RotateCcw,
  Info,
  X,
  type LucideIcon
} from "lucide-react";
import { api } from "../../api/client";
import { AppSelect, type AppSelectOption } from "../common/AppSelect";
import { ToggleSwitch } from "../common/ToggleSwitch";
const Toggle = ToggleSwitch;
import { useAppSettings, type AppLanguage } from "../../contexts/AppSettingsContext";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";
import { useTheme } from "../../contexts/ThemeContext";
import { SubscriptionBillingCenter } from "./SubscriptionBillingCenter";
import { CallSettings } from "../../features/calls/CallSettings";
import { useScreenShare } from "../../features/screenShare/useScreenShare";
import type { ScreenShareQualityMode } from "../../features/screenShare/types";
import { ProfileAccountCard } from "./ProfileAccountCard";
import { userMessagesApi } from "../../features/userMessages/userMessagesApi";
import type { ChatSettings } from "../../features/userMessages/types";
import { useMotionMode } from "../../motion/MotionProvider";
import type { MotionPreference } from "../../motion/tokens";
import { CrystalButton, CrystalCard } from "../crystal/Crystal";
import { crystalUiEnabled, type CrystalEffectsLevel } from "../../crystal/tokens";
import { isMobileAppRuntime } from "../../utils/runtime";

const APP_VERSION = import.meta.env.VITE_APP_VERSION || "1.0.3";

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

const MOTION_OPTIONS: Array<{ value: MotionPreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "full", label: "Full" },
  { value: "balanced", label: "Balanced" },
  { value: "reduced", label: "Reduced" }
];

type SettingsSection = "main" | "general" | "ai" | "screen-share" | "visual" | "subscription" | "privacy" | "calls" | "chat";
type Accent = "cyan" | "violet" | "amber" | "green" | "rose" | "red";

const SETTINGS_TABS: Array<{ section: SettingsSection; label: string }> = [
  { section: "main", label: "Account" },
  { section: "general", label: "Preferences" },
  { section: "ai", label: "AI Chat" },
  { section: "screen-share", label: "Sharing" },
  { section: "privacy", label: "Security" },
  { section: "calls", label: "Calls" },
  { section: "chat", label: "Messages" },
  { section: "visual", label: "Visual" },
  { section: "subscription", label: "Billing" }
];

function SettingsIcon({ icon: Icon, accent = "cyan" }: { icon: LucideIcon; accent?: Accent }) {
  return (
    <span
      className={clsx(
        "grid h-8 w-8 shrink-0 place-items-center rounded-md border",
        accent === "cyan" && "border-cyan-200/15 bg-cyan-200/10 text-cyan-200",
        accent === "violet" && "border-violet-200/15 bg-violet-200/10 text-violet-200",
        accent === "amber" && "border-amber-200/15 bg-amber-200/10 text-amber-200",
        accent === "green" && "border-emerald-200/15 bg-emerald-200/10 text-emerald-200",
        accent === "rose" && "border-rose-200/15 bg-rose-200/10 text-rose-200",
        accent === "red" && "border-red-200/15 bg-red-200/10 text-red-200"
      )}
    >
      <Icon size={16} />
    </span>
  );
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <CrystalCard className="settings-card overflow-hidden">
      {children}
    </CrystalCard>
  );
}

function SettingsGroup({
  title,
  children,
  className
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("settings-group", className)}>
      <h2 className="settings-group-title">{title}</h2>
      {children}
    </section>
  );
}

function SettingsRow({
  icon,
  accent,
  title,
  description,
  children,
  onClick,
  tone = "normal",
  showChevron = Boolean(onClick)
}: {
  icon: LucideIcon;
  accent?: Accent;
  title: string;
  description?: string;
  children?: React.ReactNode;
  onClick?: () => void;
  tone?: "normal" | "danger";
  showChevron?: boolean;
}) {
  const content = (
    <>
      <div className="settings-row-copy flex min-w-0 flex-1 items-center gap-2.5">
        <SettingsIcon icon={icon} accent={accent} />
        <div className="min-w-0 flex-1">
          <p className={clsx("settings-row-title text-[13px] font-semibold", tone === "danger" ? "text-red-200" : "text-white")}>{title}</p>
          {description && <p className="settings-row-description mt-0.5 text-[11px] text-slate-400">{description}</p>}
        </div>
      </div>
      {children && <div className="settings-row-controls flex w-full min-w-0 flex-wrap items-center justify-start gap-1.5 sm:w-auto sm:shrink-0 sm:justify-end">{children}</div>}
      {!children && showChevron && <ChevronRight className="hidden text-slate-500 sm:block" size={15} />}
    </>
  );

  const className = clsx(
    "settings-row flex w-full min-w-0 flex-col gap-2 border-b border-white/10 px-3 py-2.5 text-left last:border-b-0 sm:flex-row sm:items-center",
    onClick && "transition hover:bg-white/[0.055] focus:outline-none focus-visible:bg-white/[0.055]",
    tone === "danger" && "hover:bg-red-500/10"
  );

  if (onClick) {
    return (
      <button className={className} type="button" onClick={onClick}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}

function Select({
  value,
  onChange,
  options,
  disabled,
  label
}: {
  value: string | number;
  onChange: (value: string) => void;
  options: AppSelectOption[];
  disabled?: boolean;
  label: string;
}) {
  return (
    <AppSelect label={label} value={value} options={options} onChange={onChange} disabled={disabled} />
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const pageRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const { token, user, updateUser, logout } = useAuth();
  const screenShare = useScreenShare();
  const { chats, refreshChats, setActiveChat } = useChat();
  const { theme, setTheme } = useTheme();
  const {
    preference: motionPreference,
    setPreference: setMotionPreference,
    mode: activeMotionMode,
    tier: performanceTier,
    safeMode,
    safeModeReason,
    enableSafeMode,
    disableSafeMode
  } = useMotionMode();
  const {
    settings,
    setMemoryEnabled,
    setFeedbackLearningEnabled,
    setStreamingEnabled,
    setVoiceEnabled,
    setNotificationsEnabled,
    setLanguage,
    setVisualEffectsLevel,
    setCrystalOrb,
    setCrystalSurfaces,
    setCrystalButtonMotion,
    setCrystalVoiceVisualizer,
    resetVisualEffects
  } = useAppSettings();
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [isClearingChats, setIsClearingChats] = useState(false);
  const [chatSettings, setChatSettings] = useState<ChatSettings | null>(null);
  const [memoryNotice, setMemoryNotice] = useState("");
  const [versionDetailsOpen, setVersionDetailsOpen] = useState(false);

  const section = useMemo<SettingsSection>(() => {
    const current = new URLSearchParams(location.search).get("section");
    return current === "general" || current === "ai" || current === "screen-share" || current === "visual" || current === "subscription" || current === "privacy" || current === "calls" || current === "chat" ? current : "main";
  }, [location.search]);

  const sectionTitle = section === "general" ? "General" : section === "ai" ? "AI Chat" : section === "screen-share" ? "Screen Share" : section === "visual" ? "Visual Effects" : section === "subscription" ? "Subscription" : section === "privacy" ? "Privacy & Security" : section === "calls" ? "Calls" : section === "chat" ? "Messages" : "Settings";

  useEffect(() => {
    setNotificationPermission("Notification" in window ? Notification.permission : "unsupported");
  }, []);

  useEffect(() => {
    if (typeof user?.memory_enabled === "boolean" && settings.memoryEnabled !== user.memory_enabled) {
      setMemoryEnabled(user.memory_enabled);
    }
    if (
      typeof user?.feedback_learning_enabled === "boolean"
      && settings.feedbackLearningEnabled !== user.feedback_learning_enabled
    ) {
      setFeedbackLearningEnabled(user.feedback_learning_enabled);
    }
  }, [user?.feedback_learning_enabled, user?.memory_enabled]);

  async function updatePersonalizationSetting(
    field: "memory_enabled" | "feedback_learning_enabled",
    enabled: boolean
  ) {
    if (!token) return;
    const localSetter = field === "memory_enabled" ? setMemoryEnabled : setFeedbackLearningEnabled;
    const previous = field === "memory_enabled" ? settings.memoryEnabled : settings.feedbackLearningEnabled;
    localSetter(enabled);
    setMemoryNotice("");
    try {
      const nextUser = await api.updateProfile(token, { [field]: enabled });
      updateUser(nextUser);
    } catch (error) {
      localSetter(previous);
      setMemoryNotice(error instanceof Error ? error.message : "Unable to update personalization settings.");
    }
  }

  async function clearLearnedPreferences() {
    if (!token || !window.confirm("Clear all learned preferences for this account?")) return;
    try {
      await api.clearMemories(token);
      setMemoryNotice("Learned preferences cleared.");
    } catch (error) {
      setMemoryNotice(error instanceof Error ? error.message : "Unable to clear learned preferences.");
    }
  }

  async function exportMemories() {
    if (!token) return;
    try {
      const memories = await api.listMemories(token);
      const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), memories }, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "autoai-memories.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMemoryNotice(error instanceof Error ? error.message : "Unable to export learned preferences.");
    }
  }

  useEffect(() => {
    if (!token || section !== "chat") return;
    void userMessagesApi.settings(token).then(setChatSettings).catch(() => undefined);
  }, [section, token]);

  useEffect(() => {
    const page = pageRef.current;
    const tabs = tabsRef.current;
    const activeTab = tabs?.querySelector<HTMLElement>(`[data-settings-section="${section}"]`);

    page?.scrollTo({ top: 0, behavior: "auto" });
    if (!tabs || !activeTab) return;

    const targetLeft = activeTab.offsetLeft - (tabs.clientWidth - activeTab.offsetWidth) / 2;
    tabs.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
  }, [section]);

  function openSection(nextSection: Exclude<SettingsSection, "main">) {
    navigate(`/settings?section=${nextSection}`);
  }

  function selectTab(nextSection: SettingsSection) {
    navigate(nextSection === "main" ? "/settings" : `/settings?section=${nextSection}`);
  }

  function openContextMemory() {
    const event = () => window.dispatchEvent(new CustomEvent("open-context-panel", { detail: { tab: "memory" } }));
    try {
      const result = navigate("/chat") as void | Promise<void>;
      if (result && typeof result.catch === "function") {
        void result
          .then(() => window.setTimeout(event, 60))
          .catch((error: unknown) => {
            console.error("[Auto-AI Navigation] Failed to open context and memory.", error);
          });
        return;
      }
      window.setTimeout(event, 60);
    } catch (error) {
      console.error("[Auto-AI Navigation] Failed to open context and memory.", error);
    }
  }

  function goBack() {
    if (section !== "main") {
      navigate("/settings");
      return;
    }
    try {
      const result = navigate("/hub") as void | Promise<void>;
      if (result && typeof result.catch === "function") {
        void result.catch((error: unknown) => {
          console.error("[Auto-AI Navigation] Failed to leave settings.", error);
        });
      }
    } catch (error) {
      console.error("[Auto-AI Navigation] Failed to leave settings.", error);
      navigate("/hub");
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

  function restartInSafeMode() {
    enableSafeMode("settings");
    navigate("/hub", { replace: true });
    window.setTimeout(() => window.location.reload(), 80);
  }

  async function updateChatSettings(payload: Partial<ChatSettings>) {
    if (!token) return;
    const next = await userMessagesApi.updateSettings(token, payload);
    setChatSettings(next);
  }

  function renderMainSettings() {
    return (
      <div className="settings-section-stack">
        <ProfileAccountCard />
        <SettingsGroup title="App Settings">
          <SettingsCard>
            <SettingsRow
              icon={SlidersHorizontal}
              title="Preferences"
              description="Theme, language, notifications and motion"
              onClick={() => openSection("general")}
            />
            <SettingsRow
              icon={Bot}
              accent="violet"
              title="AI Chat"
              description="Models, streaming, voice, memory and research"
              onClick={() => openSection("ai")}
            />
            <SettingsRow
              icon={Monitor}
              accent="cyan"
              title="Screen Share"
              description="Quality, connection and session controls"
              onClick={() => openSection("screen-share")}
            />
            <SettingsRow
              icon={LockKeyhole}
              accent="green"
              title="Data & Privacy"
              description="Security, saved chats and data controls"
              onClick={() => openSection("privacy")}
            />
            <SettingsRow
              icon={PhoneCall}
              accent="cyan"
              title="Calls"
              description="Call privacy, sound and blocked users"
              onClick={() => openSection("calls")}
            />
            <SettingsRow
              icon={MessageCircle}
              accent="violet"
              title="Messages"
              description="Privacy, read receipts, typing and last seen"
              onClick={() => openSection("chat")}
            />
            <SettingsRow
              icon={Gem}
              accent="violet"
              title="Visual Effects"
              description={`Crystal UI: ${crystalUiEnabled ? settings.visualEffectsLevel : "disabled"}`}
              onClick={() => openSection("visual")}
            />
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup title="Subscription">
          <button className="settings-plan-preview" type="button" onClick={() => openSection("subscription")}>
            <span className="settings-plan-icon"><CreditCard size={22} /></span>
            <span className="min-w-0 flex-1">
              <strong>Manage your plan</strong>
              <small>Billing, token usage, promo codes and receipts</small>
            </span>
            <ChevronRight size={18} />
          </button>
          <SettingsCard>
            <SettingsRow
              icon={CreditCard}
              accent="violet"
              title="Redeem Code"
              description="Apply a promo code to an eligible plan"
              onClick={() => openSection("subscription")}
            />
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup title="About & Account">
          <SettingsCard>
            <SettingsRow icon={Monitor} title="App Version" description="Tap to view AutoAI project and feature details" onClick={() => setVersionDetailsOpen(true)}>
              <span className="text-[11px] font-semibold text-slate-300">v{APP_VERSION}</span>
            </SettingsRow>
            <SettingsRow
              icon={LogOut}
              accent="red"
              title="Sign Out"
              description="Sign out from your account"
              onClick={logout}
              tone="danger"
              showChevron={false}
            />
          </SettingsCard>
        </SettingsGroup>
      </div>
    );
  }

  function renderVisualEffectsSettings() {
    const controlsDisabled = !crystalUiEnabled || settings.visualEffectsLevel === "off";
    const levels: Array<{ value: CrystalEffectsLevel; label: string }> = [
      { value: "off", label: "Off" },
      { value: "reduced", label: "Reduced" },
      { value: "full", label: "Full" }
    ];
    return (
      <div className="grid gap-3">
        <SettingsCard>
          <SettingsRow
            icon={Gem}
            accent="violet"
            title="Visual Effects"
            description={crystalUiEnabled ? "Reduced is optimized for Android and mobile." : "Disabled by the application feature flag."}
          >
            <div className="visual-effects-segment" role="group" aria-label="Visual effects level">
              {levels.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={!crystalUiEnabled}
                  aria-pressed={settings.visualEffectsLevel === option.value}
                  onClick={() => setVisualEffectsLevel(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow icon={CircleDot} accent="cyan" title="3D AI Orb" description="CSS crystal status tied to real chat and voice activity">
            <Toggle checked={settings.crystalOrb} onChange={setCrystalOrb} disabled={controlsDisabled} />
          </SettingsRow>
          <SettingsRow icon={Gem} accent="violet" title="Crystal surfaces" description="Small cards and dialogs only">
            <Toggle checked={settings.crystalSurfaces} onChange={setCrystalSurfaces} disabled={controlsDisabled} />
          </SettingsRow>
          <SettingsRow icon={MousePointer2} accent="green" title="Button motion" description="Short press-depth feedback">
            <Toggle checked={settings.crystalButtonMotion} onChange={setCrystalButtonMotion} disabled={controlsDisabled} />
          </SettingsRow>
          <SettingsRow icon={AudioLines} accent="rose" title="Voice visualizer" description="Runs only during real listening or speaking activity">
            <Toggle checked={settings.crystalVoiceVisualizer} onChange={setCrystalVoiceVisualizer} disabled={controlsDisabled} />
          </SettingsRow>
          <SettingsRow icon={RotateCcw} title="Reset visual effects" description="Restore lightweight defaults" showChevron={false}>
            <CrystalButton className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={resetVisualEffects}>
              <RotateCcw size={13} /> Reset
            </CrystalButton>
          </SettingsRow>
        </SettingsCard>
      </div>
    );
  }

  function renderGeneralSettings() {
    return (
      <div className="grid gap-3">
        <ProfileAccountCard />

        <SettingsCard>
          <SettingsRow icon={Sun} accent="amber" title="Theme" description="Light / Dark / System">
            <div className="grid w-full grid-cols-3 gap-1 rounded-md border border-white/10 bg-slate-950/70 p-1 sm:w-auto">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  className={clsx(
                    "inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded px-1.5 text-[10px] font-semibold transition",
                    theme === value ? "bg-cyan-200/15 text-cyan-100" : "text-slate-400 hover:bg-white/10 hover:text-white"
                  )}
                >
                  <Icon size={12} />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          </SettingsRow>
          <SettingsRow
            icon={Sparkles}
            accent="violet"
            title="Motion"
            description={safeMode ? `Safe Mode active${safeModeReason ? `: ${safeModeReason}` : ""}` : `Active: ${activeMotionMode} / ${performanceTier}`}
          >
            <Select value={motionPreference} options={MOTION_OPTIONS} onChange={(value) => setMotionPreference(value as MotionPreference)} label="Motion preference" />
          </SettingsRow>
          <SettingsRow
            icon={Shield}
            accent={safeMode ? "amber" : "green"}
            title={safeMode ? "Safe Mode" : "Restart in Safe Mode"}
            description={safeMode ? "Advanced effects and experimental UI are disabled." : "Use a conservative mode if screens are blank or slow."}
          >
            {safeMode ? (
              <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={disableSafeMode}>
                Exit Safe Mode
              </button>
            ) : (
              <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={restartInSafeMode}>
                Restart in Safe Mode
              </button>
            )}
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
          <SettingsRow icon={Globe2} title="Language" description="Sets app language metadata">
            <Select value={settings.language} options={LANGUAGE_OPTIONS} onChange={(value) => setLanguage(value as AppLanguage)} label="Language" />
          </SettingsRow>
        </SettingsCard>
      </div>
    );
  }

  function renderAiSettings() {
    return (
      <div className="grid gap-3">
        <SettingsCard>
          <SettingsRow icon={Shield} title="Personalization memory" description="Pause new long-term memories while keeping existing preferences available to manage">
            <Toggle checked={settings.memoryEnabled} onChange={(checked) => void updatePersonalizationSetting("memory_enabled", checked)} />
          </SettingsRow>
          <SettingsRow icon={CheckCheck} accent="green" title="Learn from my feedback" description="Use repeated Like/Dislike patterns as gentle preferences for this account">
            <Toggle checked={settings.feedbackLearningEnabled} onChange={(checked) => void updatePersonalizationSetting("feedback_learning_enabled", checked)} />
          </SettingsRow>
          <SettingsRow icon={Radio} accent="cyan" title="Response streaming" description="Stream AI responses as they are generated">
            <Toggle checked={settings.streamingEnabled} onChange={setStreamingEnabled} />
          </SettingsRow>
          <SettingsRow icon={Mic} accent="violet" title="Voice input" description="Show AI Chat microphone controls">
            <Toggle checked={settings.voiceEnabled} onChange={setVoiceEnabled} />
          </SettingsRow>
          <SettingsRow icon={Bot} accent="cyan" title="Context, files & memory" description="Manage AI documents, saved memory and human signals" onClick={openContextMemory} />
          <SettingsRow icon={BrainCircuit} accent="violet" title="Learned preference controls" description="View, edit, delete, export, or clear account memories">
            <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={openContextMemory}>View & edit</button>
            <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={() => void exportMemories()}>Export</button>
            <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px] text-rose-200" type="button" onClick={() => void clearLearnedPreferences()}>Clear</button>
          </SettingsRow>
          <div className="px-3 py-2 text-[11px] leading-5 text-slate-400">
            AutoAI uses your approved preferences to personalize your account. Your private chats are not used as another user&apos;s personal memory.
            {memoryNotice && <p className="mt-1 text-cyan-200" role="status">{memoryNotice}</p>}
          </div>
        </SettingsCard>
      </div>
    );
  }

  function renderScreenShareSettings() {
    const active = !["idle", "ended", "failed"].includes(screenShare.uiState);
    return (
      <SettingsCard>
        <SettingsRow icon={Monitor} accent="cyan" title="Share quality" description="Used by the existing screen-sharing sender">
          <Select value={screenShare.qualityMode} options={[{ value: "auto", label: "Auto" }, { value: "data-saver", label: "Data Saver" }, { value: "sharp-text", label: "Sharp Text" }, { value: "smooth-motion", label: "Smooth Motion" }, { value: "hd", label: "HD" }]} onChange={(value) => screenShare.setQualityMode(value as ScreenShareQualityMode)} label="Screen share quality" />
        </SettingsRow>
        <SettingsRow icon={Radio} accent={active ? "green" : "cyan"} title="Connection status" description={active ? `${screenShare.uiState} · ${screenShare.networkQuality} network` : "No active screen-sharing session"} />
        <SettingsRow icon={Mic} accent="violet" title="Shared audio and session controls" description="Microphone, pause, viewer access and copy-code controls appear only during an active session" />
        <SettingsRow icon={Monitor} title="Screen permission" description="Requested only after you choose Share Screen">
          <button className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]" type="button" onClick={screenShare.requestInviteShare}>Open share controls</button>
        </SettingsRow>
      </SettingsCard>
    );
  }

  function renderPrivacySettings() {
    return (
      <SettingsCard>
        <SettingsRow icon={LockKeyhole} accent="green" title="Privacy & Security" description="Memory and local chat controls" />
        <SettingsRow icon={Trash2} accent="red" title="Clear Chats" description={`${chats.length} saved chat${chats.length === 1 ? "" : "s"}`}>
          <button
            className="btn-secondary min-h-8 px-2.5 py-1 text-[11px]"
            type="button"
            onClick={clearAllChats}
            disabled={isClearingChats || chats.length === 0}
          >
            <Trash2 size={13} />
            {isClearingChats ? "Clearing" : "Clear"}
          </button>
        </SettingsRow>
      </SettingsCard>
    );
  }

  function renderChatSettings() {
    const current = chatSettings;
    return (
      <SettingsCard>
        <SettingsRow icon={MessageCircle} accent="violet" title="Message privacy" description="Who can start a user-to-user chat">
          <Select value={current?.allow_messages_from || "everyone"} options={[{ value: "everyone", label: "Everyone" }, { value: "known_users", label: "Known users" }, { value: "nobody", label: "Nobody" }]} onChange={(value) => void updateChatSettings({ allow_messages_from: value as ChatSettings["allow_messages_from"] })} label="Allow messages from" />
        </SettingsRow>
        <SettingsRow icon={CheckCheck} accent="cyan" title="Read receipts" description="Show when you read messages">
          <ToggleSwitch label="Read receipts" showStatus checked={current?.read_receipts_enabled ?? true} onChange={(checked) => updateChatSettings({ read_receipts_enabled: checked })} disabled={!current} />
        </SettingsRow>
        <SettingsRow icon={Radio} accent="green" title="Typing indicator" description="Show when you are typing">
          <ToggleSwitch label="Typing indicators" showStatus checked={current?.typing_indicator_enabled ?? true} onChange={(checked) => updateChatSettings({ typing_indicator_enabled: checked })} disabled={!current} />
        </SettingsRow>
        <SettingsRow icon={Globe2} title="Last seen" description="Allow chat peers to see last seen">
          <ToggleSwitch label="Last seen" showStatus checked={current?.last_seen_enabled ?? true} onChange={(checked) => updateChatSettings({ last_seen_enabled: checked })} disabled={!current} />
        </SettingsRow>
      </SettingsCard>
    );
  }

  return (
    <div
      ref={pageRef}
      className={clsx(
        "settings-page settings-reference-page min-h-0 flex-1 overflow-y-auto overflow-x-hidden text-white",
        isMobileAppRuntime() && "is-native-app"
      )}
    >
      <div className="settings-reference-shell">
        <header className="settings-reference-header">
          <div className="settings-title-row">
            <button className="settings-back-button" type="button" onClick={goBack} title="Back" aria-label="Back">
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <h1>Settings</h1>
              {section !== "main" && <p>{sectionTitle}</p>}
            </div>
          </div>
          <nav ref={tabsRef} className="settings-tabs" aria-label="Settings categories">
            {SETTINGS_TABS.map((tab) => (
              <button
                key={tab.section}
                type="button"
                data-settings-section={tab.section}
                className={clsx(section === tab.section && "is-active")}
                onClick={() => selectTab(tab.section)}
                aria-current={section === tab.section ? "page" : undefined}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </header>

        <div className="settings-reference-content">
          {section === "main" && renderMainSettings()}
          {section === "general" && renderGeneralSettings()}
          {section === "ai" && renderAiSettings()}
          {section === "screen-share" && renderScreenShareSettings()}
          {section === "visual" && renderVisualEffectsSettings()}
          {section === "subscription" && <SubscriptionBillingCenter />}
          {section === "privacy" && renderPrivacySettings()}
          {section === "calls" && <CallSettings />}
          {section === "chat" && renderChatSettings()}
        </div>
      </div>
      {versionDetailsOpen && (
        <div className="version-details-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setVersionDetailsOpen(false)}>
          <section className="version-details-dialog" role="dialog" aria-modal="true" aria-label="AutoAI app details">
            <header><span><Info size={18} /><strong>AutoAI v{APP_VERSION}</strong></span><button type="button" onClick={() => setVersionDetailsOpen(false)} aria-label="Close app details"><X size={18} /></button></header>
            <p>AutoAI is a multi-workspace AI platform for intelligent chat, reusable attachment analysis, secure screen sharing, calls, and user messaging.</p>
            <div className="version-details-grid">
              <article><strong>AI Chat</strong><small>Automatic intelligence presets, Coding, Deep Research, response streaming, voice, memory, files, images and personal Library.</small></article>
              <article><strong>Attachment intelligence</strong><small>Photos, selfies, screenshots, documents and code are analyzed and saved automatically in each user's Library.</small></article>
              <article><strong>Screen Sharing</strong><small>Secure share codes, mobile and desktop viewing, pause/resume and movable live controls.</small></article>
              <article><strong>Communication</strong><small>User messages, audio/video calls, profiles, contacts, notifications and privacy controls.</small></article>
              <article><strong>Account & billing</strong><small>Subscriptions, token usage, promo codes, payment history, receipts and app updates.</small></article>
              <article><strong>Privacy</strong><small>Account-scoped chats, files, memories and Library items with user-controlled deletion and settings.</small></article>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
