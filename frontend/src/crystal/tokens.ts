export type CrystalEffectsLevel = "off" | "reduced" | "full";
export type CrystalOrbState = "idle" | "ready" | "listening" | "thinking" | "streaming" | "speaking" | "error" | "offline";
export type CrystalCallState = "calling" | "ringing" | "connected" | "reconnecting" | "poor" | "ended";

export const crystalUiEnabled = import.meta.env.VITE_CRYSTAL_UI_ENABLED === "true";
export const crystalFailureStorageKey = "auto-ai-crystal-effect-failures";
export const crystalFailureThreshold = 2;

export function recordCrystalEffectFailure() {
  try {
    const current = Number(sessionStorage.getItem(crystalFailureStorageKey) || "0");
    const next = Math.min(crystalFailureThreshold, Number.isFinite(current) ? current + 1 : 1);
    sessionStorage.setItem(crystalFailureStorageKey, String(next));
    return next;
  } catch {
    return 1;
  }
}
