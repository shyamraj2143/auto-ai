export const fishAnimationStorageKey = "auto-ai-fish-animation";
export const fishAnimationChangeEvent = "auto-ai-fish-animation-change";

function shouldEnableFishByDefault() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return true;
  const smallViewport = window.matchMedia("(max-width: 900px)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  return !smallViewport && !coarsePointer && !reducedMotion && !saveData && memory > 3 && cores > 3;
}

export function readFishAnimationEnabled() {
  try {
    const stored = localStorage.getItem(fishAnimationStorageKey);
    if (stored === "on") return true;
    if (stored === "off") return false;
    return shouldEnableFishByDefault();
  } catch {
    return false;
  }
}

export function setFishAnimationEnabled(enabled: boolean) {
  try {
    localStorage.setItem(fishAnimationStorageKey, enabled ? "on" : "off");
  } catch {
    return;
  }
  window.dispatchEvent(new CustomEvent(fishAnimationChangeEvent, { detail: { enabled } }));
}
