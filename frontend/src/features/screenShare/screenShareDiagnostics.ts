export function screenShareDebug(label: string, payload: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  console.debug(`[screen-share] ${label}`, { build_version: import.meta.env.VITE_BUILD_VERSION ?? "dev", ...payload });
}
