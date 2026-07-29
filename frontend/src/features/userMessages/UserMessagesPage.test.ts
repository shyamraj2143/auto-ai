import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { timeLabel } from "./UserMessagesPage";

const workspaceSurfaces = readFileSync(new URL("../../styles/workspaceSurfaces.css", import.meta.url), "utf8");

describe("user message timestamps", () => {
  it("treats timezone-less API timestamps as UTC before formatting locally", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date("2026-07-29T07:14:00Z"));

    expect(timeLabel("2026-07-29T07:14:00")).toBe(expected);
  });

  it("preserves timestamps that already include a timezone", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date("2026-07-29T07:14:00+05:30"));

    expect(timeLabel("2026-07-29T07:14:00+05:30")).toBe(expected);
  });

  it("does not display a fabricated time for invalid data", () => {
    expect(timeLabel("not-a-date")).toBe("");
  });

  it("keeps mobile navigation clearance owned by the app shell only", () => {
    expect(workspaceSurfaces).toContain(".app-shell > main { height: 100dvh; padding-bottom: 77px; }");
    expect(workspaceSurfaces).toContain(".um-page { padding-bottom: 0; }");
    expect(workspaceSurfaces).not.toContain(".calls-workspace-page, .um-page { padding-bottom: 76px; }");
  });
});
