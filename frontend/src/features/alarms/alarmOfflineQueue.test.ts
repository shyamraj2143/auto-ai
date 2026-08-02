// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./alarmsApi", () => ({ alarmsApi: { action: vi.fn() } }));

import { alarmsApi } from "./alarmsApi";
import { enqueueAlarmAction, flushAlarmActions } from "./alarmOfflineQueue";

const action = vi.mocked(alarmsApi.action);

describe("browser alarm offline action queue", () => {
  beforeEach(() => {
    window.localStorage.clear();
    action.mockReset();
  });

  it("keeps the latest ordered action per alarm and removes it after sync", async () => {
    enqueueAlarmAction({ userId: "user-1", alarmId: "alarm-1", action: "snooze", snoozeMinutes: 10, scheduledAt: "2026-08-02T03:30:00.000Z", clientRevision: 4, queuedAt: "2026-08-02T03:20:00.000Z" });
    enqueueAlarmAction({ userId: "user-1", alarmId: "alarm-1", action: "dismiss", snoozeMinutes: 10, scheduledAt: "2026-08-02T03:30:00.000Z", clientRevision: 5, queuedAt: "2026-08-02T03:21:00.000Z" });
    action.mockResolvedValue({} as never);

    await expect(flushAlarmActions("user-1", "token")).resolves.toBe(0);
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith("token", "alarm-1", "dismiss", 10, { scheduledAt: "2026-08-02T03:30:00.000Z", clientRevision: 5 });
    expect(window.localStorage.getItem("autoai-alarm-offline-actions-v1")).toBeNull();
  });

  it("retains a verified dismissal when the server is still unreachable", async () => {
    enqueueAlarmAction({ userId: "user-1", alarmId: "alarm-2", action: "dismiss", snoozeMinutes: 10, scheduledAt: "2026-08-02T03:30:00.000Z", clientRevision: 3, queuedAt: "2026-08-02T03:22:00.000Z" });
    action.mockRejectedValue(new Error("offline"));

    await expect(flushAlarmActions("user-1", "token")).resolves.toBe(1);
    expect(window.localStorage.getItem("autoai-alarm-offline-actions-v1")).toContain("alarm-2");
  });
});
