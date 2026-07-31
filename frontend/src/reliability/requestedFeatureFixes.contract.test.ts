import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("requested user-facing feature fixes", () => {
  it("keeps response language controls in AI Chat", () => {
    const chat = source("components/chat/ChatPage.tsx");
    expect(chat).toContain("Response language");
    expect(chat).toContain("autoai-response-${settings.responseLanguage}");
  });

  it("uses direct first-click screen sharing and compact controls", () => {
    const workspace = source("features/screenShare/ScreenShareWorkspacePage.tsx");
    const overlay = source("features/screenShare/ScreenShareOverlay.tsx");
    expect(workspace).toContain("await screenShare.generateShareCode()");
    expect(overlay).toContain("ss-dock-compact");
    expect(overlay).not.toContain("Screen share quality");
  });

  it("keeps app version details and mobile layout fixes", () => {
    const settings = source("components/settings/SettingsPage.tsx");
    const css = source("styles/featureFixes.css");
    expect(settings).toContain("AutoAI app details");
    expect(css).toContain(".um-chat-head > button");
    expect(css).toContain(".app-select-menu");
  });
});
