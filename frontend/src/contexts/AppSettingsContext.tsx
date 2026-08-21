import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { AiProvider } from "../types";
import { crystalFailureThreshold, crystalUiEnabled, type CrystalEffectsLevel } from "../crystal/tokens";
import { useMotionMode } from "../motion/MotionProvider";
export type AppLanguage = "system" | "en" | "hi" | "hinglish";
export type ResponseLanguage = "auto" | "en" | "hi";

export type AppSettings = {
  defaultProvider: AiProvider;
  defaultModel: string;
  memoryEnabled: boolean;
  feedbackLearningEnabled: boolean;
  streamingEnabled: boolean;
  voiceEnabled: boolean;
  notificationsEnabled: boolean;
  language: AppLanguage;
  responseLanguage: ResponseLanguage;
  visualEffectsLevel: CrystalEffectsLevel;
  crystalOrb: boolean;
  crystalSurfaces: boolean;
  crystalButtonMotion: boolean;
  crystalVoiceVisualizer: boolean;
  assistantEnabled: boolean;
  assistantSpokenResponses: boolean;
  assistantPersonalization: boolean;
  assistantActionConfirmations: boolean;
};

type AppSettingsContextValue = {
  settings: AppSettings;
  setDefaultProvider: (provider: AiProvider) => void;
  setDefaultModel: (model: string) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setFeedbackLearningEnabled: (enabled: boolean) => void;
  setStreamingEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setLanguage: (language: AppLanguage) => void;
  setResponseLanguage: (language: ResponseLanguage) => void;
  setVisualEffectsLevel: (level: CrystalEffectsLevel) => void;
  setCrystalOrb: (enabled: boolean) => void;
  setCrystalSurfaces: (enabled: boolean) => void;
  setCrystalButtonMotion: (enabled: boolean) => void;
  setCrystalVoiceVisualizer: (enabled: boolean) => void;
  resetVisualEffects: () => void;
  setAssistantEnabled: (enabled: boolean) => void;
  setAssistantSpokenResponses: (enabled: boolean) => void;
  setAssistantPersonalization: (enabled: boolean) => void;
  setAssistantActionConfirmations: (enabled: boolean) => void;
};

const STORAGE_KEY = "auto-ai-app-settings";

export const PROVIDER_MODELS: Record<AiProvider, Array<{ value: string; label: string }>> = {
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { value: "gpt-4o-mini", label: "GPT-4o mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-5-mini", label: "GPT-5 mini" }
  ],
  groq: [
    { value: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { value: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B" },
    { value: "qwen/qwen3-32b", label: "Qwen 3 32B" },
    { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout" }
  ]
};

const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: "groq",
  defaultModel: PROVIDER_MODELS.groq[0].value,
  memoryEnabled: true,
  feedbackLearningEnabled: true,
  streamingEnabled: true,
  voiceEnabled: true,
  notificationsEnabled: false,
  language: "system",
  responseLanguage: "auto",
  visualEffectsLevel: "reduced",
  crystalOrb: true,
  crystalSurfaces: true,
  crystalButtonMotion: true,
  crystalVoiceVisualizer: true,
  assistantEnabled: true,
  assistantSpokenResponses: false,
  assistantPersonalization: true,
  assistantActionConfirmations: true
};

const LANGUAGE_VALUES = new Set<AppLanguage>(["system", "en", "hi", "hinglish"]);
const RESPONSE_LANGUAGE_VALUES = new Set<ResponseLanguage>(["auto", "en", "hi"]);
function normalizeSettings(payload: unknown): AppSettings {
  if (!payload || typeof payload !== "object") return DEFAULT_SETTINGS;
  const raw = payload as Partial<AppSettings>;
  const provider = raw.defaultProvider === "openai" || raw.defaultProvider === "groq"
    ? raw.defaultProvider
    : DEFAULT_SETTINGS.defaultProvider;
  const validModels = PROVIDER_MODELS[provider].map((item) => item.value);
  const model = raw.defaultModel && validModels.includes(raw.defaultModel)
    ? raw.defaultModel
    : PROVIDER_MODELS[provider][0].value;
  return {
    defaultProvider: provider,
    defaultModel: model,
    memoryEnabled: raw.memoryEnabled ?? DEFAULT_SETTINGS.memoryEnabled,
    feedbackLearningEnabled: raw.feedbackLearningEnabled ?? DEFAULT_SETTINGS.feedbackLearningEnabled,
    streamingEnabled: raw.streamingEnabled ?? DEFAULT_SETTINGS.streamingEnabled,
    voiceEnabled: raw.voiceEnabled ?? DEFAULT_SETTINGS.voiceEnabled,
    notificationsEnabled: raw.notificationsEnabled ?? DEFAULT_SETTINGS.notificationsEnabled,
    language: raw.language && LANGUAGE_VALUES.has(raw.language) ? raw.language : DEFAULT_SETTINGS.language,
    responseLanguage: raw.responseLanguage && RESPONSE_LANGUAGE_VALUES.has(raw.responseLanguage)
      ? raw.responseLanguage
      : DEFAULT_SETTINGS.responseLanguage,
    visualEffectsLevel: raw.visualEffectsLevel === "off" || raw.visualEffectsLevel === "reduced" || raw.visualEffectsLevel === "full"
      ? raw.visualEffectsLevel
      : DEFAULT_SETTINGS.visualEffectsLevel,
    crystalOrb: typeof raw.crystalOrb === "boolean" ? raw.crystalOrb : DEFAULT_SETTINGS.crystalOrb,
    crystalSurfaces: typeof raw.crystalSurfaces === "boolean" ? raw.crystalSurfaces : DEFAULT_SETTINGS.crystalSurfaces,
    crystalButtonMotion: typeof raw.crystalButtonMotion === "boolean" ? raw.crystalButtonMotion : DEFAULT_SETTINGS.crystalButtonMotion,
    crystalVoiceVisualizer: typeof raw.crystalVoiceVisualizer === "boolean" ? raw.crystalVoiceVisualizer : DEFAULT_SETTINGS.crystalVoiceVisualizer,
    assistantEnabled: typeof raw.assistantEnabled === "boolean" ? raw.assistantEnabled : DEFAULT_SETTINGS.assistantEnabled,
    assistantSpokenResponses: typeof raw.assistantSpokenResponses === "boolean" ? raw.assistantSpokenResponses : DEFAULT_SETTINGS.assistantSpokenResponses,
    assistantPersonalization: typeof raw.assistantPersonalization === "boolean" ? raw.assistantPersonalization : DEFAULT_SETTINGS.assistantPersonalization,
    assistantActionConfirmations: typeof raw.assistantActionConfirmations === "boolean" ? raw.assistantActionConfirmations : DEFAULT_SETTINGS.assistantActionConfirmations
  };
}

function readStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeStoredSettings(settings: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("[Auto-AI Settings] Unable to save settings to localStorage.", error);
  }
}

const AppSettingsContext = createContext<AppSettingsContextValue | undefined>(undefined);

export function AppSettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(() => readStoredSettings());
  const { safeMode, systemReduced } = useMotionMode();

  useEffect(() => {
    const nextLang =
      settings.language === "system"
        ? navigator.language || "en"
        : settings.language === "hinglish"
          ? "hi-Latn"
          : settings.language;
    document.documentElement.lang = nextLang;
  }, [settings.language]);

  const updateSettings = useCallback((updater: (current: AppSettings) => AppSettings) => {
    setSettings((current) => {
      const nextSettings = normalizeSettings(updater(current));
      writeStoredSettings(nextSettings);
      return nextSettings;
    });
  }, []);

  useLayoutEffect(() => {
    const effectiveLevel: CrystalEffectsLevel = !crystalUiEnabled || safeMode
      ? "off"
      : systemReduced
        ? "reduced"
        : settings.visualEffectsLevel;
    const active = effectiveLevel !== "off";
    const root = document.documentElement;
    root.dataset.autoAiCrystal = effectiveLevel;
    root.dataset.autoAiCrystalSurfaces = active && settings.crystalSurfaces ? "true" : "false";
    root.dataset.autoAiCrystalButtons = active && settings.crystalButtonMotion ? "true" : "false";
    root.dataset.autoAiCrystalOrb = active && settings.crystalOrb ? "true" : "false";
    root.dataset.autoAiCrystalVoice = active && settings.crystalVoiceVisualizer ? "true" : "false";
    root.classList.toggle("crystal-ui", active);
    return () => {
      delete root.dataset.autoAiCrystal;
      delete root.dataset.autoAiCrystalSurfaces;
      delete root.dataset.autoAiCrystalButtons;
      delete root.dataset.autoAiCrystalOrb;
      delete root.dataset.autoAiCrystalVoice;
      root.classList.remove("crystal-ui");
    };
  }, [safeMode, settings.crystalButtonMotion, settings.crystalOrb, settings.crystalSurfaces, settings.crystalVoiceVisualizer, settings.visualEffectsLevel, systemReduced]);

  useEffect(() => {
    const handleFailure = (event: Event) => {
      const failures = event instanceof CustomEvent ? Number(event.detail?.failures) : 0;
      if (failures < crystalFailureThreshold) return;
      updateSettings((current) => current.visualEffectsLevel === "full"
        ? { ...current, visualEffectsLevel: "reduced" }
        : current);
    };
    window.addEventListener("auto-ai-crystal-failure", handleFailure);
    return () => window.removeEventListener("auto-ai-crystal-failure", handleFailure);
  }, [updateSettings]);

  const value = useMemo<AppSettingsContextValue>(
    () => ({
      settings,
      setDefaultProvider: (provider) => {
        updateSettings((current) => ({
          ...current,
          defaultProvider: provider,
          defaultModel: PROVIDER_MODELS[provider][0].value
        }));
      },
      setDefaultModel: (model) => {
        updateSettings((current) => ({ ...current, defaultModel: model }));
      },
      setMemoryEnabled: (enabled) => {
        updateSettings((current) => ({ ...current, memoryEnabled: enabled }));
      },
      setFeedbackLearningEnabled: (enabled) => {
        updateSettings((current) => ({ ...current, feedbackLearningEnabled: enabled }));
      },
      setStreamingEnabled: (enabled) => {
        updateSettings((current) => ({ ...current, streamingEnabled: enabled }));
      },
      setVoiceEnabled: (enabled) => {
        updateSettings((current) => ({ ...current, voiceEnabled: enabled }));
      },
      setNotificationsEnabled: (enabled) => {
        updateSettings((current) => ({ ...current, notificationsEnabled: enabled }));
      },
      setLanguage: (language) => {
        updateSettings((current) => ({ ...current, language }));
      },
      setResponseLanguage: (responseLanguage) => {
        updateSettings((current) => ({ ...current, responseLanguage }));
      },
      setVisualEffectsLevel: (level) => {
        updateSettings((current) => ({ ...current, visualEffectsLevel: level }));
      },
      setCrystalOrb: (enabled) => {
        updateSettings((current) => ({ ...current, crystalOrb: enabled }));
      },
      setCrystalSurfaces: (enabled) => {
        updateSettings((current) => ({ ...current, crystalSurfaces: enabled }));
      },
      setCrystalButtonMotion: (enabled) => {
        updateSettings((current) => ({ ...current, crystalButtonMotion: enabled }));
      },
      setCrystalVoiceVisualizer: (enabled) => {
        updateSettings((current) => ({ ...current, crystalVoiceVisualizer: enabled }));
      },
      setAssistantEnabled: (enabled) => updateSettings((current) => ({ ...current, assistantEnabled: enabled })),
      setAssistantSpokenResponses: (enabled) => updateSettings((current) => ({ ...current, assistantSpokenResponses: enabled })),
      setAssistantPersonalization: (enabled) => updateSettings((current) => ({ ...current, assistantPersonalization: enabled })),
      setAssistantActionConfirmations: (enabled) => updateSettings((current) => ({ ...current, assistantActionConfirmations: enabled })),
      resetVisualEffects: () => {
        updateSettings((current) => ({
          ...current,
          visualEffectsLevel: DEFAULT_SETTINGS.visualEffectsLevel,
          crystalOrb: DEFAULT_SETTINGS.crystalOrb,
          crystalSurfaces: DEFAULT_SETTINGS.crystalSurfaces,
          crystalButtonMotion: DEFAULT_SETTINGS.crystalButtonMotion,
          crystalVoiceVisualizer: DEFAULT_SETTINGS.crystalVoiceVisualizer
        }));
      }
    }),
    [settings, updateSettings]
  );

  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings() {
  const context = useContext(AppSettingsContext);
  if (!context) throw new Error("useAppSettings must be used within AppSettingsProvider");
  return context;
}
