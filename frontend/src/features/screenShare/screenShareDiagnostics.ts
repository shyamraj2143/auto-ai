export function screenShareDebug(label: string, payload: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.debug(`[screen-share] ${label}`, payload);
}
