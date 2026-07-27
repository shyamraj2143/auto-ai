import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeUpdateState = { installedVersionCode: number; installedVersionName: string; latestVersionCode?: number; latestVersionName?: string; updateAvailable: boolean; mandatory?: boolean; state: string; message?: string };
type NativeUpdatePlugin = {
  getState(): Promise<NativeUpdateState>;
  openUpdate(): Promise<NativeUpdateState>;
  addListener(event: "stateChanged", listener: (state: NativeUpdateState) => void): Promise<PluginListenerHandle>;
};

export const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const shouldShowUpdate = (state: NativeUpdateState | null) =>
  isNativeAndroid() && Boolean(state?.updateAvailable && (state.latestVersionCode ?? 0) > state.installedVersionCode);
export const NativeUpdate = registerPlugin<NativeUpdatePlugin>("AutoAiUpdate");
