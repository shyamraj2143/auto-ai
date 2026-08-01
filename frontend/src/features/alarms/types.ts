export type AlarmLanguage = "hi-IN" | "hinglish-IN" | "en-IN";
export type AlarmVoiceStyle = "warm" | "gentle" | "energetic";
export type AlarmRingtone = "system" | "gentle" | "energetic";

export type UserAlarm = {
  id: string;
  title: string;
  note: string;
  scheduled_at: string;
  timezone: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
  assistant_message: string;
  ai_model: string;
  ai_generated: boolean;
  enabled: boolean;
  status: string;
  snooze_count: number;
  revision: number;
  last_triggered_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type AlarmDraft = {
  title: string;
  note: string;
  scheduled_at: string;
  timezone: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
};

export type AlarmListResponse = {
  items: UserAlarm[];
  server_time: string;
};

export type AlarmNativeStatus = {
  native: boolean;
  exactAlarmRequired: boolean;
  exactAlarmGranted: boolean;
  notificationsRequired: boolean;
  notificationsGranted: boolean;
  cameraRequired: boolean;
  cameraGranted: boolean;
  fullScreenRequired: boolean;
  fullScreenGranted: boolean;
  ready: boolean;
};

export type AlarmNativeScheduleResult = {
  scheduled: boolean;
  exact: boolean;
  triggerAtEpochMs: number;
  method: string;
  reason: string;
};

export type AlarmNativeSyncResult = {
  scheduled: number;
  failed: number;
  exact: boolean;
  reason: string;
};

export type AlarmAwakeVerification = {
  awake: boolean;
  confidence: number;
  reason: string;
  model: string;
  photo_stored: boolean;
};
