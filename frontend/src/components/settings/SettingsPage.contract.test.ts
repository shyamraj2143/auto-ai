import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsSource = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
const profileSource = readFileSync(new URL("./ProfileAccountCard.tsx", import.meta.url), "utf8");
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

  it("uses the reference glass styling without duplicate mobile bottom spacing", () => {
    expect(appCss).toContain(".settings-reference-page");
    expect(appCss).toContain(".settings-plan-preview");
    expect(surfaceCss).toContain(".settings-page { padding-bottom: 0; }");
    expect(surfaceCss).toContain(".chat-workspace { padding-bottom: 0; }");
    expect(surfaceCss).not.toContain(".chat-workspace { padding-bottom: 70px; }");
  });

  it("resets content scroll and keeps the selected category visible", () => {
    expect(settingsSource).toContain("page?.scrollTo({ top: 0");
    expect(settingsSource).toContain("tabs.scrollTo({ left:");
    expect(settingsSource).toContain("data-settings-section={tab.section}");
  });

  it("keeps the native sticky header stable without duplicating the system safe area", () => {
    expect(settingsSource).toContain('isMobileAppRuntime() && "is-native-app"');
    expect(appCss).toContain(".settings-reference-page.is-native-app .settings-reference-header");
    expect(appCss).toContain("overscroll-behavior-y: contain");
    expect(appCss).toContain("overflow-anchor: none");
  });

  it("uses a compact clickable profile summary before opening the editor", () => {
    expect(profileSource).toContain('className="profile-account-summary"');
    expect(profileSource).toContain("aria-expanded={editing}");
    expect(profileSource).toContain('id="profile-account-editor"');
    expect(appCss).toContain("grid-template-columns: 60px minmax(0, 1fr) auto");
  });

  it("stacks select controls safely on narrow mobile viewports", () => {
    expect(settingsSource).toContain("settings-row-controls");
    expect(appCss).toContain("@media (max-width: 420px)");
    expect(appCss).toContain(".settings-reference-page .settings-row:has(.app-select-root)");
    expect(appCss).toContain("max-height:min(70dvh, 520px)");
  });
});
