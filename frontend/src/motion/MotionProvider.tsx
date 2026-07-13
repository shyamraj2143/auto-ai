import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  advancedMotionEnabled,
  cinematicWebsiteEnabled,
  motionStorageKey,
  type DevicePerformanceTier,
  type MotionMode,
  type MotionPreference
} from "./tokens";

type MotionContextValue = {
  enabled: boolean;
  preference: MotionPreference;
  setPreference: (preference: MotionPreference) => void;
  mode: MotionMode;
  tier: DevicePerformanceTier;
  reduceMotion: boolean;
  visible: boolean;
  canUseAmbient: boolean;
  canUseCinematic: boolean;
  canUsePointerEffects: boolean;
  canUseWebGl: boolean;
};

const MotionContext = createContext<MotionContextValue | undefined>(undefined);

function readPreference(): MotionPreference {
  try {
    const stored = localStorage.getItem(motionStorageKey);
    return stored === "full" || stored === "balanced" || stored === "reduced" || stored === "system" ? stored : "system";
  } catch {
    return "system";
  }
}

function getSystemReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getDeviceTier(): DevicePerformanceTier {
  if (typeof navigator === "undefined") return "balanced";
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection?.saveData;
  const effectiveType = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType ?? "";
  if (saveData || memory <= 2 || cores <= 2 || /2g/.test(effectiveType)) return "low";
  if (memory >= 8 && cores >= 8) return "high";
  return "balanced";
}

function useAppVisibility() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible" && document.hasFocus());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);

    const capacitorApp = (window as unknown as {
      Capacitor?: { Plugins?: { App?: { addListener?: (eventName: string, callback: (state: { isActive?: boolean }) => void) => { remove?: () => void } | Promise<{ remove?: () => void }> } } };
    }).Capacitor?.Plugins?.App;
    let appListener: { remove?: () => void } | undefined;
    const listenerResult = capacitorApp?.addListener?.("appStateChange", (state) => {
      setVisible(Boolean(state.isActive));
    });
    if (listenerResult && "then" in listenerResult) {
      void listenerResult.then((listener) => {
        appListener = listener;
      });
    } else {
      appListener = listenerResult;
    }

    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      appListener?.remove?.();
    };
  }, []);

  return visible;
}

function modeFromPreference(preference: MotionPreference, systemReduced: boolean, tier: DevicePerformanceTier): MotionMode {
  if (!advancedMotionEnabled) return "reduced";
  if (preference === "reduced" || (preference === "system" && systemReduced)) return "reduced";
  if (preference === "full") return tier === "low" ? "balanced" : "full";
  if (preference === "balanced") return "balanced";
  return tier === "high" ? "full" : tier === "balanced" ? "balanced" : "reduced";
}

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<MotionPreference>(() => readPreference());
  const [systemReduced, setSystemReduced] = useState(() => getSystemReducedMotion());
  const [tier, setTier] = useState<DevicePerformanceTier>(() => getDeviceTier());
  const visible = useAppVisibility();
  const mode = modeFromPreference(preference, systemReduced, tier);
  const enabled = advancedMotionEnabled;
  const reduceMotion = !enabled || mode === "reduced";

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const updateTier = () => setTier(getDeviceTier());
    window.addEventListener("online", updateTier);
    window.addEventListener("offline", updateTier);
    return () => {
      window.removeEventListener("online", updateTier);
      window.removeEventListener("offline", updateTier);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.autoAiMotion = enabled ? mode : "off";
    root.dataset.autoAiCinematic = cinematicWebsiteEnabled && enabled && mode !== "reduced" ? "true" : "false";
    root.dataset.autoAiPerformance = tier;
    root.dataset.autoAiVisible = visible ? "true" : "false";
    root.classList.toggle("advanced-motion", enabled);
    root.classList.toggle("cinematic-website", cinematicWebsiteEnabled && enabled && mode !== "reduced");
    root.classList.toggle("motion-reduced", reduceMotion);
    root.classList.toggle("app-hidden", !visible);
  }, [enabled, mode, reduceMotion, tier, visible]);

  const setPreference = useCallback((next: MotionPreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(motionStorageKey, next);
    } catch (error) {
      console.warn("[Auto-AI Motion] Unable to save motion preference.", error);
    }
  }, []);

  const value = useMemo<MotionContextValue>(() => {
    const pointerFine = typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const callActive = typeof document !== "undefined" && document.documentElement.dataset.autoAiCallActive === "true";
    return {
      enabled,
      preference,
      setPreference,
      mode,
      tier,
      reduceMotion,
      visible,
      canUseAmbient: enabled && visible && !callActive && mode !== "reduced",
      canUseCinematic: cinematicWebsiteEnabled && enabled && visible && mode !== "reduced" && tier !== "low",
      canUsePointerEffects: enabled && visible && pointerFine && mode === "full" && tier !== "low",
      canUseWebGl: false
    };
  }, [enabled, mode, preference, reduceMotion, setPreference, tier, visible]);

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotionMode() {
  const context = useContext(MotionContext);
  if (!context) throw new Error("useMotionMode must be used within MotionProvider");
  return context;
}
