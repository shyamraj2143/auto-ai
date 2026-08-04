import { Capacitor, registerPlugin } from "@capacitor/core";

export type NativeCapabilityStatus = "SUPPORTED" | "USER_PERMISSION_REQUIRED" | "EXTERNAL_APP_REQUIRED" | "GUIDED_ONLY" | "UNSUPPORTED" | "BLOCKED_BY_POLICY";
export type NativePermissionStatus = "GRANTED" | "DENIED" | "PERMANENTLY_DENIED" | "UNAVAILABLE" | "NOT_REQUIRED";

type NativeCapabilities = {
  platform: "android";
  camera: NativeCapabilityStatus;
  cameraPermission: NativePermissionStatus;
  documentPicker: NativeCapabilityStatus;
  biometric: NativeCapabilityStatus;
  customTabs: NativeCapabilityStatus;
  network: "ONLINE" | "OFFLINE" | "UNKNOWN";
  batteryPercent: number | null;
};

interface AutoAiServiceCapabilitiesPlugin {
  getCapabilities(): Promise<NativeCapabilities>;
  requestCameraPermission(): Promise<{ status: NativePermissionStatus }>;
  openPortal(options: { url: string; officialOrigin: string }): Promise<{ opened: boolean }>;
  confirmHighRisk(options: { title: string; subtitle: string }): Promise<{ confirmed: boolean; method: string }>;
  openAppSettings(): Promise<{ opened: boolean }>;
}

const NativeServiceCapabilities = registerPlugin<AutoAiServiceCapabilitiesPlugin>("AutoAiServiceCapabilities");

export const serviceNative = {
  isAndroid: () => Capacitor.getPlatform() === "android",
  async capabilities(): Promise<NativeCapabilities | { platform: "web"; camera: "UNSUPPORTED"; cameraPermission: "UNAVAILABLE"; documentPicker: "SUPPORTED"; biometric: "UNSUPPORTED"; customTabs: "UNSUPPORTED"; network: "ONLINE" | "OFFLINE"; batteryPercent: null }> {
    if (!this.isAndroid()) {
      return { platform: "web", camera: "UNSUPPORTED", cameraPermission: "UNAVAILABLE", documentPicker: "SUPPORTED", biometric: "UNSUPPORTED", customTabs: "UNSUPPORTED", network: navigator.onLine ? "ONLINE" : "OFFLINE", batteryPercent: null };
    }
    return NativeServiceCapabilities.getCapabilities();
  },
  async requestCamera(): Promise<NativePermissionStatus> {
    if (!this.isAndroid()) return "UNAVAILABLE";
    return (await NativeServiceCapabilities.requestCameraPermission()).status;
  },
  async openPortal(url: string, officialOrigin: string): Promise<boolean> {
    if (!this.isAndroid()) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.origin !== officialOrigin) throw new Error("Portal destination failed origin validation.");
      window.open(target.toString(), "_blank", "noopener,noreferrer");
      return true;
    }
    return (await NativeServiceCapabilities.openPortal({ url, officialOrigin })).opened;
  },
  async confirmHighRisk(title: string, subtitle: string): Promise<"confirmed" | "unavailable"> {
    if (!this.isAndroid()) return "unavailable";
    const result = await NativeServiceCapabilities.confirmHighRisk({ title, subtitle });
    if (result.confirmed) return "confirmed";
    if (result.method === "cancelled") throw new Error("Device confirmation was cancelled. Nothing was authorized.");
    return "unavailable";
  },
  async openSettings(): Promise<void> {
    if (this.isAndroid()) await NativeServiceCapabilities.openAppSettings();
  }
};
