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
    expect(context).toContain("Android did not arm it");
    expect(context).toContain("ensureNativeAccess");
  });

  it("retains explicit desktop and small-mobile responsive layouts", () => {
    const css = source("src/features/alarms/alarms.css");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (max-width: 390px)");
    expect(css).toContain("word-break: normal");
  });

  it("requires a live camera and awake verification before desktop dismissal", () => {
    const overlay = source("src/features/alarms/AlarmOverlay.tsx");
    const verifier = source("src/features/alarms/webAwakeVerifier.ts");
    const queue = source("src/features/alarms/alarmOfflineQueue.ts");
    expect(overlay).toContain("navigator.mediaDevices?.getUserMedia");
    expect(overlay).toContain("verifyAwakeOnDevice(canvas)");
    expect(overlay).toContain("verifyAwake(activeAlarm.id, photo)");
    expect(overlay).toContain("Verify to stop");
    expect(overlay).toContain("setInterval(speakReminder");
    expect(verifier).toContain("FaceLandmarker.createFromOptions");
    expect(verifier).toContain("models/face_landmarker.task");
    expect(queue).toContain("autoai-alarm-offline-actions-v1");
    expect(queue).toContain("clientRevision");
  });

  it("shows a seconds clock and forces alarm setup to 24-hour controls", () => {
    const page = source("src/features/alarms/AlarmPage.tsx");
    const time = source("src/features/alarms/alarmTime.ts");
    expect(page).toContain("LiveAlarmClock");
    expect(page).toContain("formatAlarmTime24(now, true)");
    expect(page).toContain("Hour from 00 to 23");
    expect(page).toContain("Tomorrow · 07:00");
    expect(page).toContain("Evening · 18:00");
    expect(time).toContain("includeSeconds");
  });
});
