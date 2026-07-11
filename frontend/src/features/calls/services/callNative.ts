import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeIncomingCall = {
  callId?: string | null;
  action?: "accept" | "reject" | "audio_only" | null;
};

type NativeCallPlugin = {
  getDeviceRegistration(): Promise<{ deviceId: string; fcmToken?: string | null; appVersion?: string | null; appVersionCode?: number | null; deviceName?: string | null }>;
  consumeIncomingCall(): Promise<NativeIncomingCall>;
  startActiveCall(options: { callId: string; displayName: string; startedAt: number; video: boolean }): Promise<void>;
  stopActiveCall(): Promise<void>;
  setSpeaker(options: { enabled: boolean }): Promise<void>;
  openAppSettings(): Promise<void>;
};

const NativeCalls = registerPlugin<NativeCallPlugin>("AutoAiCalls");
const BROWSER_DEVICE_KEY = "auto-ai-call-device-id";

function browserDeviceId() {
  let deviceId = localStorage.getItem(BROWSER_DEVICE_KEY);
  if (!deviceId) {
    deviceId = `web-${crypto.randomUUID()}`;
    localStorage.setItem(BROWSER_DEVICE_KEY, deviceId);
  }
  return deviceId;
}

export const callNative = {
  isAndroid: () => Capacitor.getPlatform() === "android",
  async registration() {
    if (Capacitor.getPlatform() === "android") {
      const registration = await NativeCalls.getDeviceRegistration();
      return {
        device_id: registration.deviceId,
        platform: "android" as const,
        fcm_token: registration.fcmToken,
        app_version: registration.appVersion,
        app_version_code: registration.appVersionCode ?? 0,
        device_name: registration.deviceName,
      };
    }
    return { device_id: browserDeviceId(), platform: "web" as const, fcm_token: null, app_version: null, app_version_code: 0, device_name: null };
  },
  consumeIncomingCall: () => Capacitor.getPlatform() === "android" ? NativeCalls.consumeIncomingCall() : Promise.resolve({}),
  startActiveCall: (options: { callId: string; displayName: string; startedAt: number; video: boolean }) =>
    Capacitor.getPlatform() === "android" ? NativeCalls.startActiveCall(options) : Promise.resolve(),
  stopActiveCall: () => Capacitor.getPlatform() === "android" ? NativeCalls.stopActiveCall() : Promise.resolve(),
  setSpeaker: (enabled: boolean) => Capacitor.getPlatform() === "android" ? NativeCalls.setSpeaker({ enabled }) : Promise.resolve(),
  openAppSettings: () => Capacitor.getPlatform() === "android" ? NativeCalls.openAppSettings() : Promise.resolve(),
};
