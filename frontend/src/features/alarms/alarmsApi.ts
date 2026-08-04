import { apiFetch } from "../../api/client";
import type { AlarmAssistantResult, AlarmAwakeVerification, AlarmDraft, AlarmLanguage, AlarmListResponse, UserAlarm } from "./types";

export const alarmsApi = {
  assistantCommand: (token: string, payload: { transcript: string; timezone: string; client_request_id: string; language: AlarmLanguage }) => apiFetch<AlarmAssistantResult>("/alarms/assistant/command", {
    method: "POST", token, body: JSON.stringify(payload), operation: "alarms.assistantCommand", timeoutMs: 12_000,
  }),
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
  action: (
    token: string,
    alarmId: string,
    action: "ringing" | "dismiss" | "snooze" | "skip",
    snoozeMinutes = 10,
    options: { scheduledAt?: string; clientRevision?: number } = {},
  ) => apiFetch<UserAlarm>(
    `/alarms/${encodeURIComponent(alarmId)}/action`,
    {
      method: "POST",
      token,
      operation: `alarms.${action}`,
      body: JSON.stringify({
        action,
        snooze_minutes: snoozeMinutes,
        scheduled_at: options.scheduledAt,
        client_revision: options.clientRevision,
      }),
    },
  ),
  verifyAwake: (token: string, alarmId: string, photo: Blob) => {
    const form = new FormData();
    form.append("file", photo, "awake.jpg");
    return apiFetch<AlarmAwakeVerification>(`/alarms/${encodeURIComponent(alarmId)}/verify-awake`, {
      method: "POST",
      token,
      operation: "alarms.verifyAwake",
      timeoutMs: 5_500,
      body: form,
    });
  },
  remove: (token: string, alarmId: string) => apiFetch<void>(`/alarms/${encodeURIComponent(alarmId)}`, {
    method: "DELETE",
    token,
    operation: "alarms.delete",
  }),
};
