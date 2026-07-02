import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type AiProvider = "openai" | "groq" | "bedrock";

export type AppSettings = {
  defaultProvider: AiProvider;
  defaultModel: string;
  memoryEnabled: boolean;
  streamingEnabled: boolean;
  voiceEnabled: boolean;
};

type AppSettingsContextValue = {
  settings: AppSettings;
  setDefaultProvider: (provider: AiProvider) => void;
  setDefaultModel: (model: string) => void;
  setMemoryEnabled: (enabled: boolean) => void;
  setStreamingEnabled: (enabled: boolean) => void;
  setVoiceEnabled: (enabled: boolean) => void;
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
    { value: "openai.gpt-oss-120b", label: "GPT-OSS 120B" },
    { value: "openai.gpt-oss-20b", label: "GPT-OSS 20B" },
    { value: "mistral.ministral-3-8b-instruct", label: "Ministral 3 8B" },
    { value: "mistral.ministral-3-14b-instruct", label: "Ministral 3 14B" },
    { value: "mistral.mistral-large-3-675b-instruct", label: "Mistral Large 3" },
    { value: "google.gemma-3-27b-it", label: "Gemma 3 27B" },
    { value: "qwen.qwen3-coder-30b-a3b-instruct", label: "Qwen 3 Coder 30B" }
  ]
};

const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: "groq",
  defaultModel: PROVIDER_MODELS.groq[0].value,
  memoryEnabled: true,
  streamingEnabled: true,
  voiceEnabled: true
};

function normalizeSettings(payload: unknown): AppSettings {
  if (!payload || typeof payload !== "object") return DEFAULT_SETTINGS;
  const raw = payload as Partial<AppSettings>;
  const provider = raw.defaultProvider === "openai" || raw.defaultProvider === "groq" || raw.defaultProvider === "bedrock"
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
    streamingEnabled: raw.streamingEnabled ?? DEFAULT_SETTINGS.streamingEnabled,
    voiceEnabled: raw.voiceEnabled ?? DEFAULT_SETTINGS.voiceEnabled
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

  const updateSettings = useCallback((updater: (current: AppSettings) => AppSettings) => {
    setSettings((current) => {
      const nextSettings = normalizeSettings(updater(current));
      writeStoredSettings(nextSettings);
      return nextSettings;
    });
  }, []);

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
