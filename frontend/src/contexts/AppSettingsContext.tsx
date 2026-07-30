import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { AiProvider, ResearchProvider } from "../types";
import { crystalFailureThreshold, crystalUiEnabled, type CrystalEffectsLevel } from "../crystal/tokens";
import { useMotionMode } from "../motion/MotionProvider";
export type AppLanguage = "system" | "en" | "hi" | "hinglish";

export type AppSettings = {
  defaultProvider: AiProvider;
  defaultModel: string;
  memoryEnabled: boolean;
  streamingEnabled: boolean;
  voiceEnabled: boolean;
  notificationsEnabled: boolean;
  language: AppLanguage;
  deepResearchProviders: ResearchProvider[];
  deepResearchMaxModels: number;
  deepResearchAllModels: boolean;
  deepResearchTimeoutSeconds: number;
  visualEffectsLevel: CrystalEffectsLevel;
  crystalOrb: boolean;
  crystalSurfaces: boolean;
  crystalButtonMotion: boolean;
  crystalVoiceVisualizer: boolean;
};

type AppSettingsContextValue = {
  settings: AppSettings;
  setDefaultProvider: (provider: AiProvider) => void;
  setDefaultModel: (model: string) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setStreamingEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setLanguage: (language: AppLanguage) => void;
  setDeepResearchProviders: (providers: ResearchProvider[]) => void;
  setDeepResearchMaxModels: (maxModels: number) => void;
  setDeepResearchAllModels: (enabled: boolean) => void;
  setDeepResearchTimeoutSeconds: (seconds: number) => void;
  setVisualEffectsLevel: (level: CrystalEffectsLevel) => void;
  setCrystalOrb: (enabled: boolean) => void;
  setCrystalSurfaces: (enabled: boolean) => void;
  setCrystalButtonMotion: (enabled: boolean) => void;
  setCrystalVoiceVisualizer: (enabled: boolean) => void;
  resetVisualEffects: () => void;
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
  ],
  bedrock: [
    { value: "amazon.nova-lite-v1:0", label: "Nova Lite" },
    { value: "amazon.nova-pro-v1:0", label: "Nova Pro" },
    { value: "anthropic.claude-3-haiku-20240307-v1:0", label: "Claude 3 Haiku" },
    { value: "openai.gpt-oss-120b", label: "GPT-OSS 120B" },
    { value: "openai.gpt-oss-20b", label: "GPT-OSS 20B" },
    { value: "mistral.ministral-3-8b-instruct", label: "Ministral 3 8B" },
    { value: "mistral.ministral-3-14b-instruct", label: "Ministral 3 14B" },
    { value: "mistral.mistral-large-3-675b-instruct", label: "Mistral Large 3" },
    { value: "google.gemma-3-27b-it", label: "Gemma 3 27B" },
    { value: "qwen.qwen3-coder-30b-a3b-instruct", label: "Qwen 3 Coder 30B" }
  ],
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" }
  ]
};

const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: "groq",
  defaultModel: PROVIDER_MODELS.groq[0].value,
  memoryEnabled: true,
  streamingEnabled: true,
  voiceEnabled: true,
  notificationsEnabled: false,
  language: "system",
  deepResearchProviders: ["groq", "bedrock"],
  deepResearchMaxModels: 9,
  deepResearchAllModels: true,
  deepResearchTimeoutSeconds: 45,
  visualEffectsLevel: "reduced",
  crystalOrb: true,
  crystalSurfaces: true,
  crystalButtonMotion: true,
  crystalVoiceVisualizer: true
};

const LANGUAGE_VALUES = new Set<AppLanguage>(["system", "en", "hi", "hinglish"]);
function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeResearchProviders(value: unknown) {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.deepResearchProviders;
  const providers = value.filter((item): item is ResearchProvider => item === "groq" || item === "bedrock" || item === "openai" || item === "gemini");
  return providers.length ? Array.from(new Set(providers)) : DEFAULT_SETTINGS.deepResearchProviders;
}

function normalizeSettings(payload: unknown): AppSettings {
  if (!payload || typeof payload !== "object") return DEFAULT_SETTINGS;
  const raw = payload as Partial<AppSettings>;
  const provider = raw.defaultProvider === "openai" || raw.defaultProvider === "groq" || raw.defaultProvider === "bedrock" || raw.defaultProvider === "gemini"
    ? raw.defaultProvider
    : DEFAULT_SETTINGS.defaultProvider;
  const validModels = PROVIDER_MODELS[provider].map((item) => item.value);
  const model = raw.defaultModel && validModels.includes(raw.defaultModel)
    ? raw.defaultModel
    : PROVIDER_MODELS[provider][0].value;
  const hasLegacyResearchDefaults =
    raw.deepResearchMaxModels === 3 && raw.deepResearchAllModels === false;

  return {
    defaultProvider: provider,
    defaultModel: model,
    memoryEnabled: raw.memoryEnabled ?? DEFAULT_SETTINGS.memoryEnabled,
    streamingEnabled: raw.streamingEnabled ?? DEFAULT_SETTINGS.streamingEnabled,
    voiceEnabled: raw.voiceEnabled ?? DEFAULT_SETTINGS.voiceEnabled,
    notificationsEnabled: raw.notificationsEnabled ?? DEFAULT_SETTINGS.notificationsEnabled,
    language: raw.language && LANGUAGE_VALUES.has(raw.language) ? raw.language : DEFAULT_SETTINGS.language,
    deepResearchProviders: normalizeResearchProviders(raw.deepResearchProviders),
    deepResearchMaxModels: hasLegacyResearchDefaults
      ? DEFAULT_SETTINGS.deepResearchMaxModels
      : clampNumber(raw.deepResearchMaxModels, DEFAULT_SETTINGS.deepResearchMaxModels, 1, 9),
    deepResearchAllModels: hasLegacyResearchDefaults
      ? DEFAULT_SETTINGS.deepResearchAllModels
      : raw.deepResearchAllModels ?? DEFAULT_SETTINGS.deepResearchAllModels,
    deepResearchTimeoutSeconds: clampNumber(
      raw.deepResearchTimeoutSeconds,
      DEFAULT_SETTINGS.deepResearchTimeoutSeconds,
      20,
      120
    ),
    visualEffectsLevel: raw.visualEffectsLevel === "off" || raw.visualEffectsLevel === "reduced" || raw.visualEffectsLevel === "full"
      ? raw.visualEffectsLevel
      : DEFAULT_SETTINGS.visualEffectsLevel,
    crystalOrb: typeof raw.crystalOrb === "boolean" ? raw.crystalOrb : DEFAULT_SETTINGS.crystalOrb,
    crystalSurfaces: typeof raw.crystalSurfaces === "boolean" ? raw.crystalSurfaces : DEFAULT_SETTINGS.crystalSurfaces,
    crystalButtonMotion: typeof raw.crystalButtonMotion === "boolean" ? raw.crystalButtonMotion : DEFAULT_SETTINGS.crystalButtonMotion,
    crystalVoiceVisualizer: typeof raw.crystalVoiceVisualizer === "boolean" ? raw.crystalVoiceVisualizer : DEFAULT_SETTINGS.crystalVoiceVisualizer
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
      setDeepResearchProviders: (providers) => {
        updateSettings((current) => ({ ...current, deepResearchProviders: providers }));
      },
      setDeepResearchMaxModels: (maxModels) => {
        updateSettings((current) => ({ ...current, deepResearchMaxModels: maxModels }));
      },
      setDeepResearchAllModels: (enabled) => {
        updateSettings((current) => ({ ...current, deepResearchAllModels: enabled }));
      },
      setDeepResearchTimeoutSeconds: (seconds) => {
        updateSettings((current) => ({ ...current, deepResearchTimeoutSeconds: seconds }));
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
