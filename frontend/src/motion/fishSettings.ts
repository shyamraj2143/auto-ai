export const fishAnimationStorageKey = "auto-ai-fish-animation";
export const fishAnimationChangeEvent = "auto-ai-fish-animation-change";

export function readFishAnimationEnabled() {
  try {
    return localStorage.getItem(fishAnimationStorageKey) !== "off";
  } catch {
    return true;
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
