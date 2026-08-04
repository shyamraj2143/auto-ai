import { describe, expect, it } from "vitest";
import { combineLocalDateTime, countdownLabel, defaultAlarmDate, formatAlarmDate, formatAlarmTime24, localDateInput, localTimeInput, nextLocalAlarmTime, quickAlarmDate } from "./alarmTime";

describe("alarm time helpers", () => {
  it("defaults to tomorrow at seven in the user's local time", () => {
    const now = new Date(2026, 7, 1, 23, 10, 0);
    const alarm = defaultAlarmDate(now);
    expect(localDateInput(alarm)).toBe("2026-08-02");
    expect(localTimeInput(alarm)).toBe("07:00");
  });

  it("combines calendar and time controls without losing local timezone semantics", () => {
    const alarm = combineLocalDateTime("2026-08-03", "08:15");
    expect(alarm?.getFullYear()).toBe(2026);
    expect(alarm?.getMonth()).toBe(7);
    expect(alarm?.getDate()).toBe(3);
    expect(alarm?.getHours()).toBe(8);
    expect(alarm?.getMinutes()).toBe(15);
  });

  it("renders every alarm clock value in explicit 24-hour format", () => {
    const midnight = new Date(2026, 7, 3, 0, 5, 9);
    const evening = new Date(2026, 7, 3, 23, 7, 4);
    expect(formatAlarmTime24(midnight)).toBe("00:05");
    expect(formatAlarmTime24(evening, true)).toBe("23:07:04");
    expect(formatAlarmDate(evening)).toMatch(/23:07$/);
    expect(formatAlarmDate(evening)).not.toMatch(/AM|PM/i);
  });

  it("creates bounded quick times and readable countdowns", () => {
    const now = new Date(2026, 7, 1, 10, 15, 0);
    expect(localTimeInput(quickAlarmDate("next-hour", now))).toBe("11:00");
    expect(countdownLabel(now.getTime() + 95 * 60_000, now.getTime())).toBe("In 1h 35m");
    expect(countdownLabel(now.getTime() - 1, now.getTime())).toBe("Due now");
  });

  it("schedules an undated once alarm at the next future local time", () => {
    const now = new Date(2026, 7, 4, 8, 0);
    expect(nextLocalAlarmTime({ time: "09:00", recurrenceType: "ONCE", now })?.getDate()).toBe(4);
    expect(nextLocalAlarmTime({ time: "07:00", recurrenceType: "ONCE", now })?.getDate()).toBe(5);
  });

  it("supports daily, weekday, weekend, and multi-day custom recurrence", () => {
    const monday = new Date(2026, 7, 3, 10, 0);
    expect(nextLocalAlarmTime({ time: "09:00", recurrenceType: "DAILY", now: monday })?.getDay()).toBe(2);
    expect(nextLocalAlarmTime({ time: "09:00", recurrenceType: "WEEKDAYS", now: new Date(2026, 7, 7, 10) })?.getDay()).toBe(1);
    expect(nextLocalAlarmTime({ time: "09:00", recurrenceType: "WEEKENDS", now: monday })?.getDay()).toBe(6);
    expect(nextLocalAlarmTime({ time: "09:00", recurrenceType: "CUSTOM", selectedWeekdays: ["WEDNESDAY", "FRIDAY"], now: monday })?.getDay()).toBe(3);
  });
});
