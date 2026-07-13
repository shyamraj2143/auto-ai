export const advancedMotionEnabled = import.meta.env.VITE_ENABLE_ADVANCED_MOTION !== "false";
export const cinematicWebsiteEnabled = import.meta.env.VITE_ENABLE_CINEMATIC_WEBSITE !== "false";

export type MotionPreference = "system" | "full" | "balanced" | "reduced";
export type MotionMode = "full" | "balanced" | "reduced";
export type DevicePerformanceTier = "high" | "balanced" | "low";
export type NeuralCoreState = "idle" | "ready" | "listening" | "thinking" | "streaming" | "speaking" | "success" | "error" | "offline";

export const motionDurations = {
  instant: 0.12,
  micro: 0.14,
  control: 0.17,
  card: 0.24,
  section: 0.62,
  page: 0.34,
  hero: 0.78
} as const;

export const motionEase = {
  crisp: [0.2, 0, 0, 1] as const,
  standard: [0.22, 1, 0.36, 1] as const,
  enter: [0.16, 1, 0.3, 1] as const,
  cinematic: [0.65, 0, 0.35, 1] as const,
  softSpring: [0.34, 1.56, 0.64, 1] as const,
  exit: [0.7, 0, 0.84, 0] as const
} as const;

export const motionStorageKey = "auto-ai-motion-preference";
