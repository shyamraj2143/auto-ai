import { apiFetch } from "../../api/client";
import type { AlarmDraft, AlarmListResponse, UserAlarm } from "./types";

export const alarmsApi = {
  list: (token: string, includeCompleted = false) => apiFetch<AlarmListResponse>(
    `/alarms?include_completed=${includeCompleted}`,
    { token, operation: "alarms.list", timeoutMs: 10_000 },
  ),
  create: (token: string, payload: AlarmDraft) => apiFetch<UserAlarm>("/alarms", {
    method: "POST",
    token,
    operation: "alarms.create",
    timeoutMs: 20_000,
    body: JSON.stringify(payload),
  }),
  update: (token: string, alarmId: string, payload: Partial<AlarmDraft> & { enabled?: boolean }) => apiFetch<UserAlarm>(
    `/alarms/${encodeURIComponent(alarmId)}`,
    {
      method: "PATCH",
      token,
      operation: "alarms.update",
      timeoutMs: 20_000,
      body: JSON.stringify(payload),
    },
  ),
  action: (token: string, alarmId: string, action: "ringing" | "dismiss" | "snooze", snoozeMinutes = 10) => apiFetch<UserAlarm>(
    `/alarms/${encodeURIComponent(alarmId)}/action`,
    {
      method: "POST",
      token,
      operation: `alarms.${action}`,
      body: JSON.stringify({ action, snooze_minutes: snoozeMinutes }),
    },
  ),
  remove: (token: string, alarmId: string) => apiFetch<void>(`/alarms/${encodeURIComponent(alarmId)}`, {
    method: "DELETE",
    token,
    operation: "alarms.delete",
  }),
};
