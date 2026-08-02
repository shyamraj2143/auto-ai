import { alarmsApi } from "./alarmsApi";

export type QueuedAlarmAction = {
  userId: string;
  alarmId: string;
  action: "dismiss" | "snooze";
  snoozeMinutes: number;
  scheduledAt?: string;
  clientRevision: number;
  queuedAt: string;
};

const STORAGE_KEY = "autoai-alarm-offline-actions-v1";

function readQueue(): QueuedAlarmAction[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item) => item && typeof item.alarmId === "string" && typeof item.userId === "string") : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedAlarmAction[]) {
  if (typeof window === "undefined") return;
  try {
    if (items.length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-50)));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The verified alarm still stops locally when private storage is unavailable.
  }
}

export function enqueueAlarmAction(action: QueuedAlarmAction) {
  const queue = readQueue().filter((item) => !(item.userId === action.userId && item.alarmId === action.alarmId));
  queue.push(action);
  writeQueue(queue);
}

export async function flushAlarmActions(userId: string, token: string) {
  const queue = readQueue();
  const pending = [...queue];
  let changed = false;
  for (const item of queue) {
    if (item.userId !== userId) continue;
    try {
      await alarmsApi.action(token, item.alarmId, item.action, item.snoozeMinutes, {
        scheduledAt: item.scheduledAt,
        clientRevision: item.clientRevision,
      });
      const index = pending.findIndex((candidate) => candidate.userId === item.userId && candidate.alarmId === item.alarmId && candidate.queuedAt === item.queuedAt);
      if (index >= 0) pending.splice(index, 1);
      changed = true;
    } catch {
      break;
    }
  }
  if (changed) writeQueue(pending);
  return pending.filter((item) => item.userId === userId).length;
}
