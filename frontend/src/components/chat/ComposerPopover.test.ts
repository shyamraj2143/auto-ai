import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calculateComposerPopoverPosition } from "./ComposerPopover";

const VIEWPORTS = [
  [320, 568], [360, 640], [360, 800], [375, 667], [393, 873],
  [412, 915], [568, 320], [915, 412], [768, 1024]
] as const;

describe("composer popover geometry", () => {
  it.each(VIEWPORTS)("stays above the trigger and within %ix%i", (width, height) => {
    const triggerTop = height - 86;
    const result = calculateComposerPopoverPosition({
      triggerRect: { top: triggerTop, left: width - 150, right: width - 12 },
      viewportLeft: 0,
      viewportTop: 0,
      viewportWidth: width,
      viewportHeight: height,
      windowHeight: height,
      preferredWidth: 420,
      maxWidth: 420,
      placement: "top-end"
    });
    expect(Number(result.left)).toBeGreaterThanOrEqual(12);
    expect(Number(result.left) + Number(result.width)).toBeLessThanOrEqual(width - 12);
    expect(Number(result.bottom)).toBe(height - triggerTop + 8);
    expect(Number(result.maxHeight)).toBeLessThanOrEqual(triggerTop - 16);
  });

  it("uses the visual viewport when the soft keyboard is visible", () => {
    const result = calculateComposerPopoverPosition({
      triggerRect: { top: 430, left: 10, right: 54 },
      viewportLeft: 0,
      viewportTop: 120,
      viewportWidth: 360,
      viewportHeight: 400,
      windowHeight: 800,
      preferredWidth: 320,
      maxWidth: 320,
      placement: "top-start"
    });
    expect(result.left).toBe(12);
    expect(result.bottom).toBe(378);
    expect(result.maxHeight).toBe(294);
  });
});

describe("composer popover contracts", () => {
  const composer = readFileSync(new URL("./Composer.tsx", import.meta.url), "utf8");
  const popover = readFileSync(new URL("./ComposerPopover.tsx", import.meta.url), "utf8");

  it("portals panels to the dedicated document.body root", () => {
    expect(popover).toContain('document.getElementById("composer-popover-root")');
    expect(popover).toContain("document.body.appendChild(portalRoot)");
    expect(popover).toContain("createPortal(");
  });

  it("preserves camera, photo, and document picker contracts", () => {
    expect(composer).toContain('accept="image/*" capture="environment"');
    expect(composer).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(composer).toContain('accept=".pdf,.docx,.txt"');
    expect(composer).toContain("openCameraPicker");
    expect(composer).toContain("openImagePicker");
    expect(composer).toContain("openDocumentPicker");
  });

  it("uses one menu state with preset-only intelligence controls", () => {
    expect(composer).toContain("const [openMenu, setOpenMenu]");
    expect(composer).not.toContain('className="model-menu-subpanel"');
    expect(composer).toContain('openMenu === "attachments"');
    expect(composer).toContain('openMenu === "mode"');
    expect(composer).not.toContain('openMenu === "model"');
    expect(composer).not.toContain('openMenu === "research-model"');
    expect(composer).not.toContain("Configure models");
    expect(composer).not.toContain("Up to 6");
  });

  it("supports Escape, outside pointer, focus restoration, and centralized Android Back", () => {
    expect(popover).toContain('event.key !== "Escape"');
    expect(popover).toContain("onPointerDown");
    expect(popover).toContain('window.addEventListener("auto-ai-android-back"');
    expect(popover).toContain("focus({ preventScroll: true })");
  });

  it("keeps preset selection and upload/send contracts without manual model state", () => {
    expect(composer).toContain("composerModeOption(value)");
    expect(composer).toContain("setChatMode(option.chatMode)");
    expect(composer).not.toContain("selectModelProvider");
    expect(composer).toContain("onUploadDocuments(documentFiles)");
    expect(composer).toContain("onSend(");
    expect(composer).toContain('coding: "Two Qwen Coder models collaborate on coding tasks."');
  });
});
