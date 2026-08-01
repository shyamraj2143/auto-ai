import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("AI Alarm feature contracts", () => {
  it("keeps the feature in the Action Hub and authenticated workspace", () => {
    const hub = source("src/features/actionHub/ActionHubPage.tsx");
    const app = source("src/App.tsx");
    expect(hub).toContain('title="AI Alarm"');
    expect(hub).toContain('navigate("/alarms")');
    expect(app).toContain('<Route path="/alarms" element={<AlarmPage />} />');
  });

  it("uses backend persistence and native scheduling instead of a browser-only timer", () => {
    const context = source("src/features/alarms/AlarmContext.tsx");
    const native = source("src/features/alarms/alarmNative.ts");
    expect(context).toContain("alarmsApi.create");
    expect(context).toContain("alarmNative.sync");
    expect(native).toContain('registerPlugin<AutoAiAlarmPlugin>("AutoAiAlarm")');
    expect(native).toContain("scheduledAtEpochMs");
  });

  it("retains explicit desktop and small-mobile responsive layouts", () => {
    const css = source("src/features/alarms/alarms.css");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (max-width: 390px)");
    expect(css).toContain("word-break: normal");
  });
});
