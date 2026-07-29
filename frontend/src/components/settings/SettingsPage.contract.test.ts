import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
const surfaceCss = readFileSync(new URL("../../styles/workspaceSurfaces.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../../styles/index.css", import.meta.url), "utf8");

describe("settings reference layout contracts", () => {
  it("keeps every functional settings section in the category navigation", () => {
    for (const section of [
      "main",
      "general",
      "ai",
      "screen-share",
      "privacy",
      "calls",
      "chat",
      "visual",
      "subscription"
    ]) {
      expect(settingsSource).toContain(`section: "${section}"`);
    }
  });

  it("keeps the complete settings groups visible from the account overview", () => {
    for (const label of [
      "Preferences",
      "AI Chat",
      "Screen Share",
      "Data & Privacy",
      "Calls",
      "Messages",
      "Visual Effects",
      "Manage your plan",
      "Redeem Code",
      "App Version",
      "Sign Out"
    ]) {
      expect(settingsSource).toContain(label);
    }
  });

  it("uses the reference glass styling and lowers the mobile composer safely", () => {
    expect(appCss).toContain(".settings-reference-page");
    expect(appCss).toContain(".settings-plan-preview");
    expect(surfaceCss).toContain(".chat-workspace { padding-bottom: 70px; }");
  });
});
