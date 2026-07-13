import { Capacitor, registerPlugin } from "@capacitor/core";

type NativeIncomingCall = {
  callId?: string | null;
  action?: "accept" | "reject" | "audio_only" | null;
};

export type NativePermissionState = {
  state: "granted" | "denied" | "prompt" | "prompt-with-rationale";
  granted: boolean;
  permanentlyDenied: boolean;
  canAskAgain: boolean;
  required: boolean;
};

export type NativeCallPermissionResult = {
  microphone: NativePermissionState;
  camera: NativePermissionState;
  notifications: NativePermissionState;
  bluetoothConnect: NativePermissionState;
  canStartAudioCall: boolean;
  canStartVideoCall: boolean;
  granted: boolean;
  missing: string[];
  requiresSettings: boolean;
};

type NativeCallPlugin = {
  getDeviceRegistration(): Promise<{ deviceId: string; fcmToken?: string | null; appVersion?: string | null; appVersionCode?: number | null; deviceName?: string | null }>;
  consumeIncomingCall(): Promise<NativeIncomingCall>;
  checkCallPermissions(options?: { video?: boolean }): Promise<NativeCallPermissionResult>;
  requestAudioCallPermissions(): Promise<NativeCallPermissionResult>;
  requestVideoCallPermissions(options?: { video?: boolean }): Promise<NativeCallPermissionResult>;
  requestNotificationPermission(): Promise<NativeCallPermissionResult>;
  requestBluetoothConnectPermission(): Promise<NativeCallPermissionResult>;
  startActiveCall(options: { callId: string; displayName: string; startedAt: number; video: boolean }): Promise<void>;
  stopActiveCall(options?: { callId?: string | null }): Promise<void>;
  setSpeaker(options: { enabled: boolean }): Promise<void>;
  setAudioRoute(options: { route: "earpiece" | "speaker" | "wired" | "bluetooth" }): Promise<void>;
  checkFullScreenIntentPermission(): Promise<{ required: boolean; granted: boolean }>;
  openAppSettings(): Promise<void>;
  openAppNotificationSettings(): Promise<void>;
  openFullScreenIntentSettings(): Promise<void>;
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
  checkCallPermissions: (video = false) => Capacitor.getPlatform() === "android" ? NativeCalls.checkCallPermissions({ video }) : Promise.resolve(defaultPermissions()),
  requestAudioCallPermissions: () => Capacitor.getPlatform() === "android" ? NativeCalls.requestAudioCallPermissions() : Promise.resolve(defaultPermissions()),
  requestVideoCallPermissions: () => Capacitor.getPlatform() === "android" ? NativeCalls.requestVideoCallPermissions({ video: true }) : Promise.resolve(defaultPermissions()),
  requestNotificationPermission: () => Capacitor.getPlatform() === "android" ? NativeCalls.requestNotificationPermission() : Promise.resolve(defaultPermissions()),
  requestBluetoothConnectPermission: () => Capacitor.getPlatform() === "android" ? NativeCalls.requestBluetoothConnectPermission() : Promise.resolve(defaultPermissions()),
  startActiveCall: (options: { callId: string; displayName: string; startedAt: number; video: boolean }) =>
    Capacitor.getPlatform() === "android" ? NativeCalls.startActiveCall(options) : Promise.resolve(),
  stopActiveCall: (callId?: string | null) => Capacitor.getPlatform() === "android" ? NativeCalls.stopActiveCall({ callId }) : Promise.resolve(),
  setSpeaker: (enabled: boolean) => Capacitor.getPlatform() === "android" ? NativeCalls.setSpeaker({ enabled }) : Promise.resolve(),
  setAudioRoute: (route: "earpiece" | "speaker" | "wired" | "bluetooth") => Capacitor.getPlatform() === "android" ? NativeCalls.setAudioRoute({ route }) : Promise.resolve(),
  checkFullScreenIntentPermission: () => Capacitor.getPlatform() === "android" ? NativeCalls.checkFullScreenIntentPermission() : Promise.resolve({ required: false, granted: true }),
  openAppSettings: () => Capacitor.getPlatform() === "android" ? NativeCalls.openAppSettings() : Promise.resolve(),
  openAppNotificationSettings: () => Capacitor.getPlatform() === "android" ? NativeCalls.openAppNotificationSettings() : Promise.resolve(),
  openFullScreenIntentSettings: () => Capacitor.getPlatform() === "android" ? NativeCalls.openFullScreenIntentSettings() : Promise.resolve(),
};

function defaultPermission(): NativePermissionState {
  return { state: "granted", granted: true, permanentlyDenied: false, canAskAgain: false, required: false };
}

function defaultPermissions(): NativeCallPermissionResult {
  const permission = defaultPermission();
  return {
    microphone: permission,
    camera: permission,
    notifications: permission,
    bluetoothConnect: permission,
    canStartAudioCall: true,
    canStartVideoCall: true,
    granted: true,
    missing: [],
    requiresSettings: false,
  };
}
