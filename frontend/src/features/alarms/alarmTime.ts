export function localDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTimeInput(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatAlarmTime24(value: string | number | Date, includeSeconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return includeSeconds ? "--:--:--" : "--:--";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return includeSeconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
}

export function formatAlarmCalendarDate(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function defaultAlarmDate(now = new Date()) {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(7, 0, 0, 0);
  return next;
}

export function combineLocalDateTime(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = new Date(`${date}T${time}:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export const ALARM_WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;

export function nextLocalAlarmTime(options: {
  time: string;
  date?: string;
  recurrenceType: "ONCE" | "DAILY" | "WEEKDAYS" | "WEEKENDS" | "CUSTOM" | "SPECIFIC_DATE";
  selectedWeekdays?: readonly string[];
  startDate?: string;
  endDate?: string;
  now?: Date;
}) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.time)) return null;
  const now = options.now ? new Date(options.now) : new Date();
  const [hours, minutes] = options.time.split(":").map(Number);
  const make = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes, 0, 0);
  if (options.recurrenceType === "ONCE" || options.recurrenceType === "SPECIFIC_DATE") {
    const base = options.date ? new Date(`${options.date}T00:00:00`) : now;
    if (Number.isNaN(base.getTime())) return null;
    const candidate = make(base);
    if (!options.date && candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate > now ? candidate : null;
  }
  const selected = options.recurrenceType === "DAILY" ? [...ALARM_WEEKDAYS]
    : options.recurrenceType === "WEEKDAYS" ? [...ALARM_WEEKDAYS.slice(0, 5)]
    : options.recurrenceType === "WEEKENDS" ? [...ALARM_WEEKDAYS.slice(5)]
    : [...(options.selectedWeekdays || [])];
  const start = options.startDate ? new Date(`${options.startDate}T00:00:00`) : now;
  const end = options.endDate ? new Date(`${options.endDate}T23:59:59`) : null;
  const cursor = start > now ? start : now;
  for (let offset = 0; offset < 366 * 6; offset += 1) {
    const day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + offset);
    if (end && day > end) return null;
    const mondayIndex = (day.getDay() + 6) % 7;
    const candidate = make(day);
    if (selected.includes(ALARM_WEEKDAYS[mondayIndex]) && candidate > now) return candidate;
  }
  return null;
}

export function formatAlarmDate(value: string | number | Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return `${formatAlarmCalendarDate(date)} · ${formatAlarmTime24(date)}`;
}

export function countdownLabel(value: string | number | Date, now = Date.now()) {
  const difference = new Date(value).getTime() - now;
  if (!Number.isFinite(difference)) return "Time unavailable";
  if (difference <= 0) return "Due now";
  const totalMinutes = Math.ceil(difference / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `In ${days}d ${hours}h`;
  if (hours > 0) return `In ${hours}h ${minutes}m`;
  return `In ${minutes}m`;
}

export function quickAlarmDate(kind: "tomorrow-morning" | "today-evening" | "next-hour", now = new Date()) {
  const value = new Date(now);
  if (kind === "tomorrow-morning") {
    value.setDate(value.getDate() + 1);
    value.setHours(7, 0, 0, 0);
  } else if (kind === "today-evening") {
    value.setHours(18, 0, 0, 0);
    if (value.getTime() <= now.getTime() + 20_000) value.setDate(value.getDate() + 1);
  } else {
    value.setHours(value.getHours() + 1, 0, 0, 0);
  }
  return value;
}
