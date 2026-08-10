export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function pageItems<T>(value: unknown): T[] {
  if (!value || typeof value !== "object") return [];
  return asArray<T>((value as { items?: unknown }).items);
}

export function pageCount(value: unknown, key: string): number {
  if (!value || typeof value !== "object") return 0;
  const count = (value as Record<string, unknown>)[key];
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}
