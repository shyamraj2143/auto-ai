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
  printing: NativeCapabilityStatus;
  network: "ONLINE" | "OFFLINE" | "UNKNOWN";
  batteryPercent: number | null;
};

interface AutoAiServiceCapabilitiesPlugin {
  getCapabilities(): Promise<NativeCapabilities>;
  requestCameraPermission(): Promise<{ status: NativePermissionStatus }>;
  openPortal(options: { url: string; officialOrigin: string }): Promise<{ opened: boolean }>;
  confirmHighRisk(options: { title: string; subtitle: string }): Promise<{ confirmed: boolean; method: string }>;
  printHtml(options: { title: string; html: string }): Promise<{ opened: boolean }>;
  openAppSettings(): Promise<{ opened: boolean }>;
}

const NativeServiceCapabilities = registerPlugin<AutoAiServiceCapabilitiesPlugin>("AutoAiServiceCapabilities");

function printInBrowser(title: string, html: string) {
  const popup = window.open("", "_blank");
  if (!popup) throw new Error("The print preview was blocked. Allow pop-ups and try again.");
  try { popup.opener = null; } catch { /* Browser may prevent changing opener. */ }
  popup.document.open();
  popup.document.write(html);
  popup.document.title = title;
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 250);
}

export const serviceNative = {
  isAndroid: () => Capacitor.getPlatform() === "android",
  async capabilities(): Promise<NativeCapabilities | { platform: "web"; camera: "UNSUPPORTED"; cameraPermission: "UNAVAILABLE"; documentPicker: "SUPPORTED"; biometric: "UNSUPPORTED"; customTabs: "UNSUPPORTED"; printing: "SUPPORTED"; network: "ONLINE" | "OFFLINE"; batteryPercent: null }> {
    if (!this.isAndroid()) {
      return { platform: "web", camera: "UNSUPPORTED", cameraPermission: "UNAVAILABLE", documentPicker: "SUPPORTED", biometric: "UNSUPPORTED", customTabs: "UNSUPPORTED", printing: "SUPPORTED", network: navigator.onLine ? "ONLINE" : "OFFLINE", batteryPercent: null };
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
  async printHtml(title: string, html: string): Promise<void> {
    if (!html.trim()) throw new Error("There is no printable application content yet.");
    if (html.length > 250_000) throw new Error("The printable application is too large. Download the official receipt instead.");
    if (!this.isAndroid()) {
      printInBrowser(title, html);
      return;
    }
    const result = await NativeServiceCapabilities.printHtml({ title, html });
    if (!result.opened) throw new Error("Android print preview could not be opened.");
  },
  async openSettings(): Promise<void> {
    if (this.isAndroid()) await NativeServiceCapabilities.openAppSettings();
  }
};
