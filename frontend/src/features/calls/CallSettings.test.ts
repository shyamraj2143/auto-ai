import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALLING_PERMISSION_ROWS, callingPermissionDisplay } from "./CallSettings";

const source = readFileSync(new URL("./CallSettings.tsx", import.meta.url), "utf8");

describe("calling permission presentation", () => {
  it("uses only the approved user-facing permission labels", () => {
    expect(CALLING_PERMISSION_ROWS).toEqual([
      ["notifications", "Notifications"],
      ["incomingChannel", "Incoming-call alerts"],
      ["microphone", "Microphone"],
      ["camera", "Camera"],
      ["bluetooth", "Bluetooth audio"],
      ["fullScreen", "Full-screen calls"],
      ["backgroundActivity", "Background activity"],
    ]);
    const labels = JSON.stringify(CALLING_PERMISSION_ROWS).toLowerCase();
    expect(labels).not.toContain("firebase");
    expect(labels).not.toContain("telecom");
    expect(labels).not.toContain("foreground");
    expect(labels).not.toContain("play services");
  });

  it("ignores unknown internal keys by using the explicit row contract", () => {
    const nativeKeys = [...CALLING_PERMISSION_ROWS.map(([key]) => key), "pushRegistration", "telecomRegistration"];
    expect(nativeKeys.filter((key) => CALLING_PERMISSION_ROWS.some(([allowed]) => allowed === key))).toHaveLength(7);
  });

  it("maps background states to safe user-facing tones", () => {
    expect(callingPermissionDisplay("backgroundActivity", "GRANTED")).toEqual({ label: "Unrestricted", tone: "ready" });
    expect(callingPermissionDisplay("backgroundActivity", "LIMITED")).toEqual({ label: "Battery optimized", tone: "limited" });
    expect(callingPermissionDisplay("backgroundActivity", "DENIED")).toEqual({ label: "Restricted", tone: "blocked" });
  });

  it("gives audio and video settings distinct, detailed call icons", () => {
    expect(source).toContain('callType="audio" icon={PhoneCall}');
    expect(source).toContain('callType="video" icon={Video}');
    expect(source).toContain("Choose which incoming calls AutoAI can receive");
  });
});
