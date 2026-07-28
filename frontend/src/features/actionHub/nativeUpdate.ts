import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeUpdateState = { installedVersionCode: number; installedVersionName: string; latestVersionCode?: number; latestVersionName?: string; updateAvailable: boolean; mandatory?: boolean; state: string; message?: string; progress?: number; downloadedBytes?: number; totalBytes?: number; errorCode?: string | null };
type NativeUpdatePlugin = {
  getState(): Promise<NativeUpdateState>;
  checkForUpdate(): Promise<NativeUpdateState>;
  openUpdate(): Promise<NativeUpdateState>;
  startDirectUpdate(): Promise<NativeUpdateState>;
  addListener(event: "stateChanged", listener: (state: NativeUpdateState) => void): Promise<PluginListenerHandle>;
};

export const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const shouldShowUpdate = (state: NativeUpdateState | null) =>
  isNativeAndroid() && Boolean(state && state.state !== "UP_TO_DATE" && state.state !== "INSTALLED" && state.updateAvailable && (state.latestVersionCode ?? 0) > state.installedVersionCode);
export const updateButtonLabel = (state: NativeUpdateState | null) => {
  switch (state?.state) {
    case "CHECKING": return "Checking...";
    case "QUEUED": case "PAUSED_WAITING_FOR_NETWORK": return "Preparing...";
    case "DOWNLOADING": return `${Math.max(0, Math.min(100, state.progress ?? 0))}%`;
    case "VERIFYING": return "Verifying...";
    case "READY_TO_INSTALL": case "OPENING_INSTALLER": return "Installing...";
    case "INSTALL_PERMISSION_REQUIRED": return "Allow install";
    case "FAILED": return "Retry";
    default: return "Update";
  }
};
export const updateButtonBusy = (state: NativeUpdateState | null) => ["CHECKING", "QUEUED", "DOWNLOADING", "VERIFYING", "READY_TO_INSTALL", "OPENING_INSTALLER"].includes(state?.state ?? "");
export const NativeUpdate = registerPlugin<NativeUpdatePlugin>("AutoAiUpdate");
