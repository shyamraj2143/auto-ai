import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AuthContext.tsx", import.meta.url), "utf8");

describe("AuthContext Android update registration", () => {
  it("registers Android devices as soon as the authenticated session is active", () => {
    expect(source).toContain("callNative.registration()");
    expect(source).toContain('registration.platform !== "android"');
    expect(source).toContain("callApi.registerDevice(token, registration)");
    expect(source).toContain("callNative.requestNotificationPermission()");
  });

  it("retries registration without blocking login rendering", () => {
    expect(source).toContain("for (let attempt = 0; attempt < 3; attempt += 1)");
    expect(source).toContain("[Auto-AI Auth] Android device registration failed.");
  });
});
