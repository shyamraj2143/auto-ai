import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("functional dialog branding regression", () => {
  it("keeps destructive Call Hub flows free of app branding", () => {
    const calls = readFileSync(new URL("../features/calls/CallsTab.tsx", import.meta.url), "utf8");
    const overlay = readFileSync(new URL("../features/calls/CallOverlay.tsx", import.meta.url), "utf8");
    expect(calls).not.toMatch(/LogoIcon|app-logo|brand-logo|logo\.svg|ic_launcher/);
    expect(overlay).not.toMatch(/auto-ai-watermark|LogoIcon|app-logo|brand-logo/);
  });

  it("has a scoped defensive rule for functional dialogs", () => {
    const css = readFileSync(new URL("../styles/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.functional-dialog \.app-logo/);
    const globalLogoRule = css.match(/(?:^|\n)\.app-logo\s*\{([^}]*)\}/)?.[1] || "";
    expect(globalLogoRule).not.toMatch(/(?:^|\n)\s*width:\s*100%/);
  });
});
