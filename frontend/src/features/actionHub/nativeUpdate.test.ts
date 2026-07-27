import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(), getPlatform: vi.fn() }, registerPlugin: vi.fn(() => ({})) }));
import { Capacitor } from "@capacitor/core";
import { shouldShowUpdate } from "./nativeUpdate";
const state = { installedVersionCode: 33, installedVersionName: "1.0.33", latestVersionCode: 34, updateAvailable: true, state: "AVAILABLE" };
describe("native update visibility", () => {
  beforeEach(() => { vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true); vi.mocked(Capacitor.getPlatform).mockReturnValue("android"); });
  it("shows only for a higher authoritative Android versionCode", () => {
    expect(shouldShowUpdate(state)).toBe(true);
    expect(shouldShowUpdate({ ...state, state: "IDLE" })).toBe(true);
    expect(shouldShowUpdate({ ...state, state: "FAILED" })).toBe(true);
    expect(shouldShowUpdate({ ...state, latestVersionCode: 33 })).toBe(false);
    expect(shouldShowUpdate({ ...state, updateAvailable: false })).toBe(false);
  });
  it("does not show on the website", () => { vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false); expect(shouldShowUpdate(state)).toBe(false); });
});
