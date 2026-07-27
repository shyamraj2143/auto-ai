import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync(new URL("./AppSelect.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../settings/SettingsPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../styles/index.css", import.meta.url), "utf8");

describe("AppSelect chooser contract", () => {
  it("uses accessible compact options without native option or brand images", () => {
    expect(component).toContain('role="combobox"');
    expect(component).toContain('role="listbox"');
    expect(component).toContain('role="option"');
    expect(component).not.toMatch(/<(select|option|img)\b/i);
    expect(component).not.toMatch(/LogoIcon|app-logo|brand-logo|CrystalCard/);
  });

  it("supports keyboard, outside click and native Android back dismissal", () => {
    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Home", "End", "Enter"]) expect(component).toContain(key);
    expect(component).toContain('App.addListener("backButton"');
    expect(component).toContain('document.addEventListener("pointerdown"');
    expect(component).toContain("option.disabled");
  });

  it("replaces every Settings native select and keeps required chooser values", () => {
    expect(settings).not.toMatch(/<(select|option)\b/);
    for (const value of ["system", "full", "balanced", "reduced", "data-saver", "sharp-text", "smooth-motion", "known_users", "nobody"]) {
      expect(settings).toContain(value);
    }
  });

  it("enforces bounded logo-free option rows and narrow-screen safety", () => {
    expect(styles).toContain("max-height:60px");
    expect(styles).toContain("min-height:48px");
    expect(styles).toContain("max-height:70vh");
    expect(styles).toContain("overflow-x:hidden");
    expect(styles).toContain(".app-select-option img");
    expect(styles).toContain("background-image:none !important");
  });
});
