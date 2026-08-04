export type AlarmLanguage = "hi-IN" | "hinglish-IN" | "en-IN";
export type AlarmVoiceStyle = "warm" | "gentle" | "energetic";
export type AlarmRingtone = "system" | "gentle" | "energetic";
export type AlarmRecurrence = "ONCE" | "DAILY" | "WEEKDAYS" | "WEEKENDS" | "CUSTOM" | "SPECIFIC_DATE";
export type AlarmWeekday = "MONDAY" | "TUESDAY" | "WEDNESDAY" | "THURSDAY" | "FRIDAY" | "SATURDAY" | "SUNDAY";

export type UserAlarm = {
  id: string;
  title: string;
  note: string;
  scheduled_at: string;
  time: string;
  date?: string | null;
  recurrence_type: AlarmRecurrence;
  selected_weekdays: number[];
  start_date?: string | null;
  end_date?: string | null;
  timezone: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
  repeat: number[];
  snooze_minutes: number;
  snooze_enabled: boolean;
  max_snooze_count: number;
  gradual_volume_enabled: boolean;
  vibration: boolean;
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
  scheduled_at?: string;
  time?: string;
  date?: string | null;
  recurrence_type?: AlarmRecurrence;
  selected_weekdays?: number[];
  start_date?: string | null;
  end_date?: string | null;
  timezone: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
  repeat: number[];
  snooze_minutes: number;
  snooze_enabled?: boolean;
  max_snooze_count?: number;
  gradual_volume_enabled?: boolean;
  vibration: boolean;
  client_request_id?: string;
};

export type AlarmAssistantResult = {
  action: "create" | "list" | "clarify" | "unsupported";
  scheduled_at?: string | null;
  timezone: string;
  label: string;
  repeat: number[];
  snooze_minutes: number;
  needs_clarification: boolean;
  clarification_question?: string | null;
  assistant_reply: string;
  confidence: number;
  intent: string;
  normalized_user_text: string;
  emotion: { tone?: string; confidence?: number };
  vibration: boolean;
  alarm?: UserAlarm | null;
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
