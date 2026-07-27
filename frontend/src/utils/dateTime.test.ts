import { afterEach, describe, expect, it } from "vitest";
import {
  formatMessageDateLabel,
  formatChatHistoryDateTime,
  formatMessageTime,
  dateSeparatorFlags,
  isSameLocalDay,
  localDayKey,
  parseApiTimestamp
} from "./dateTime";

const originalTimezone = process.env.TZ;
afterEach(() => { process.env.TZ = originalTimezone; });

describe("API datetime contract", () => {
  it("parses Z and explicit offsets without changing their instant", () => {
    expect(parseApiTimestamp("2026-07-27T09:00:00Z")?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
    expect(parseApiTimestamp("2026-07-27T14:30:00+05:30")?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
  });

  it("treats legacy T and space-separated timestamps as UTC", () => {
    expect(parseApiTimestamp("2026-07-27T09:00:00")?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
    expect(parseApiTimestamp("2026-07-27 09:00:00")?.toISOString()).toBe("2026-07-27T09:00:00.000Z");
  });

  it("returns null for empty and invalid values", () => {
    expect(parseApiTimestamp("")).toBeNull();
    expect(parseApiTimestamp("invalid")).toBeNull();
  });

  it("uses the device timezone for India and New York", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(formatMessageTime("2026-07-27T09:00:00Z", "en-IN")).toMatch(/2:30\s*pm/i);
    process.env.TZ = "America/New_York";
    expect(formatMessageTime("2026-07-27T09:00:00Z", "en-US")).toMatch(/5:00\s*AM/i);
  });

  it("formats chat-history date and time in the device timezone", () => {
    process.env.TZ = "Asia/Kolkata";
    const label = formatChatHistoryDateTime("2026-07-27T09:00:00Z", "en-IN");
    expect(label).toMatch(/27 Jul 2026/i);
    expect(label).toMatch(/2:30\s*pm/i);
  });

  it("groups by local calendar day across a UTC midnight boundary", () => {
    process.env.TZ = "Asia/Kolkata";
    expect(isSameLocalDay("2026-07-27T23:30:00Z", "2026-07-28T00:30:00Z")).toBe(true);
    expect(localDayKey("2026-07-27T20:00:00Z")).toBe("2026-07-28");
  });

  it("adds one separator for same-day messages and another on the next local day", () => {
    process.env.TZ = "UTC";
    expect(dateSeparatorFlags([
      "2026-07-27T09:00:00Z",
      "2026-07-27T10:00:00Z",
      "2026-07-28T00:01:00Z"
    ])).toEqual([true, false, true]);
  });

  it("does not duplicate a separator when a streaming message updates", () => {
    process.env.TZ = "UTC";
    const timestamps = ["2026-07-27T09:00:00Z", "2026-07-27T09:00:01Z"];
    expect(dateSeparatorFlags(timestamps)).toEqual([true, false]);
    expect(dateSeparatorFlags(timestamps)).toEqual([true, false]);
  });

  it("labels today, yesterday, and older dates", () => {
    process.env.TZ = "UTC";
    const now = new Date("2026-07-27T12:00:00Z");
    expect(formatMessageDateLabel("2026-07-27T09:00:00Z", now, "en-US")).toBe("Today");
    expect(formatMessageDateLabel("2026-07-26T09:00:00Z", now, "en-US")).toBe("Yesterday");
    expect(formatMessageDateLabel("2026-07-20T09:00:00Z", now, "en-US")).toMatch(/July 20, 2026/);
  });
});
