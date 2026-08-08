import { registerPlugin } from "@capacitor/core";

export type NativeNotificationPermissionState = { granted: boolean; prompted: boolean; canPrompt: boolean; settingsRequired: boolean };

type NativeNotificationsPlugin = {
  getState(): Promise<NativeNotificationPermissionState>;
  requestPermission(): Promise<NativeNotificationPermissionState>;
  openSettings(): Promise<NativeNotificationPermissionState>;
};

export const NativeNotifications = registerPlugin<NativeNotificationsPlugin>("AutoAiNotifications");
