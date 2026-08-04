import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { AlarmNativeScheduleResult, AlarmNativeStatus, AlarmNativeSyncResult, UserAlarm } from "./types";

export type NativeAlarmPayload = {
  alarmId: string;
  title: string;
  note: string;
  scheduledAtEpochMs: number;
  timezone: string;
  language: string;
  voiceStyle: string;
  ringtone: string;
  repeat: number[];
  recurrenceType: string;
  endDate: string;
  snoozeMinutes: number;
  snoozeEnabled: boolean;
  vibration: boolean;
  assistantMessage: string;
  enabled: boolean;
  status: string;
  revision: number;
};

type AutoAiAlarmPlugin = {
  syncAlarms(options: { alarms: NativeAlarmPayload[] }): Promise<AlarmNativeSyncResult>;
  scheduleAlarm(options: { alarm: NativeAlarmPayload }): Promise<AlarmNativeScheduleResult>;
  cancelAlarm(options: { alarmId: string }): Promise<void>;
  getStatus(): Promise<AlarmNativeStatus>;
  requestAlarmAccess(): Promise<AlarmNativeStatus>;
  previewVoice(options: { message: string; language: string; voiceStyle: string }): Promise<void>;
  addListener(eventName: "alarmAction", listener: (event: { alarmId?: string; action?: string }) => void): Promise<PluginListenerHandle>;
};

const NativeAlarm = registerPlugin<AutoAiAlarmPlugin>("AutoAiAlarm");

export function isNativeAlarmRuntime() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export function toNativeAlarm(alarm: UserAlarm): NativeAlarmPayload {
  return {
    alarmId: alarm.id,
    title: alarm.title,
    note: alarm.note,
    scheduledAtEpochMs: new Date(alarm.scheduled_at).getTime(),
    timezone: alarm.timezone,
    language: alarm.language,
    voiceStyle: alarm.voice_style,
    ringtone: alarm.ringtone,
    repeat: alarm.repeat,
    recurrenceType: alarm.recurrence_type,
    endDate: alarm.end_date || "",
    snoozeMinutes: alarm.snooze_minutes,
    snoozeEnabled: alarm.snooze_enabled,
    vibration: alarm.vibration,
    assistantMessage: alarm.assistant_message,
    enabled: alarm.enabled,
    status: alarm.status,
    revision: alarm.revision,
  };
}

const browserStatus: AlarmNativeStatus = {
  native: false,
  exactAlarmRequired: false,
  exactAlarmGranted: true,
  notificationsRequired: typeof Notification !== "undefined",
  notificationsGranted: typeof Notification === "undefined" || Notification.permission === "granted",
  cameraRequired: false,
  cameraGranted: true,
  fullScreenRequired: false,
  fullScreenGranted: true,
  ready: true,
};

export const alarmNative = {
  isAndroid: isNativeAlarmRuntime,
  sync: (alarms: UserAlarm[]) => isNativeAlarmRuntime()
    ? NativeAlarm.syncAlarms({ alarms: alarms.map(toNativeAlarm) })
    : Promise.resolve({ scheduled: 0, failed: 0, exact: false, reason: "browser_runtime" }),
  schedule: (alarm: UserAlarm) => isNativeAlarmRuntime()
    ? NativeAlarm.scheduleAlarm({ alarm: toNativeAlarm(alarm) })
    : Promise.resolve({ scheduled: false, exact: false, triggerAtEpochMs: 0, method: "browser", reason: "browser_runtime" }),
  cancel: (alarmId: string) => isNativeAlarmRuntime() ? NativeAlarm.cancelAlarm({ alarmId }) : Promise.resolve(),
  status: () => isNativeAlarmRuntime() ? NativeAlarm.getStatus() : Promise.resolve({ ...browserStatus }),
  requestAccess: async () => {
    if (isNativeAlarmRuntime()) return NativeAlarm.requestAlarmAccess();
    if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
    return { ...browserStatus, notificationsGranted: typeof Notification === "undefined" || Notification.permission === "granted" };
  },
  preview: (alarm: UserAlarm) => isNativeAlarmRuntime()
    ? NativeAlarm.previewVoice({ message: alarm.assistant_message, language: alarm.language, voiceStyle: alarm.voice_style })
    : Promise.resolve(speakInBrowser(alarm.assistant_message, alarm.language, alarm.voice_style)),
  onAction: (listener: (event: { alarmId?: string; action?: string }) => void) => isNativeAlarmRuntime()
    ? NativeAlarm.addListener("alarmAction", listener)
    : Promise.resolve({ remove: async () => undefined } as PluginListenerHandle),
};

export function speakInBrowser(message: string, language: string, voiceStyle: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(message);
  speech.lang = language === "hinglish-IN" ? "hi-IN" : language;
  speech.rate = voiceStyle === "gentle" ? 0.86 : voiceStyle === "energetic" ? 1.04 : 0.94;
  speech.pitch = voiceStyle === "gentle" ? 0.92 : voiceStyle === "energetic" ? 1.08 : 1;
  const voice = window.speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith(speech.lang.toLowerCase().split("-")[0]));
  if (voice) speech.voice = voice;
  window.speechSynthesis.speak(speech);
}
