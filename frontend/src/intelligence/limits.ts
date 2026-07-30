export const MAX_PARTICIPATING_MODELS = 6;

export function clampParticipatingModels(value: unknown, fallback = MAX_PARTICIPATING_MODELS) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(Math.round(parsed), MAX_PARTICIPATING_MODELS));
}
