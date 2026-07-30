const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseApiTimestamp(value?: string | null): Date | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalizedSeparator = trimmed.replace(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/,
    "$1T$2"
  );
  const normalized = EXPLICIT_ZONE.test(normalizedSeparator)
    ? normalizedSeparator
    : `${normalizedSeparator}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    if (import.meta.env.DEV) console.warn("Invalid API timestamp", value);
    return null;
  }
  return parsed;
}

export function normalizedApiTimestamp(value?: string | null): string | null {
  return parseApiTimestamp(value)?.toISOString() ?? null;
}

export function formatMessageTime(value?: string | null, locale?: string | string[]): string {
  const date = parseApiTimestamp(value);
  return date
    ? new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)
    : "";
}

export function formatMessageDate(value?: string | null, locale?: string | string[]): string {
  const date = parseApiTimestamp(value);
  return date
    ? new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date)
    : "";
}

export function formatMessageDateTimeTitle(value?: string | null, locale?: string | string[]): string {
  const date = parseApiTimestamp(value);
  return date
    ? new Intl.DateTimeFormat(locale, {
        weekday: "long", day: "numeric", month: "long", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "long"
      }).format(date)
    : "";
}

export function formatChatHistoryDateTime(value?: string | null, locale?: string | string[]): string {
  const date = parseApiTimestamp(value);
  return date
    ? new Intl.DateTimeFormat(locale, {
        day: "2-digit", month: "short", year: "numeric",
        hour: "numeric", minute: "2-digit"
      }).format(date)
    : "Date unavailable";
}

export function localDayKey(value?: string | null): string | null {
  const date = parseApiTimestamp(value);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isSameLocalDay(a?: string | null, b?: string | null): boolean {
  const first = localDayKey(a);
  return first !== null && first === localDayKey(b);
}

export function dateSeparatorFlags(values: Array<string | null | undefined>): boolean[] {
  return values.map((value, index) => index === 0 || !isSameLocalDay(values[index - 1], value));
}

export function formatMessageDateLabel(value?: string | null, now = new Date(), locale?: string | string[]): string {
  const date = parseApiTimestamp(value);
  if (!date) return "";
  const todaySerial = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const messageSerial = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const difference = Math.round((todaySerial - messageSerial) / 86_400_000);
  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";
  return formatMessageDate(value, locale);
}
