import type { CmsPage } from "./types";
import { isSafeCmsUrl } from "./cmsSelection";

export type CmsValidationIssue = {
  id: string;
  blockId: string;
  severity: "error" | "warning";
  message: string;
};

export function validateCmsPage(page: CmsPage): CmsValidationIssue[] {
  const issues: CmsValidationIssue[] = [];
  page.buttons.forEach((button, index) => {
    const blockId = `page-button-${index}`;
    if (!button.label.trim()) issues.push({ id: `${blockId}-empty`, blockId, severity: "error", message: `Button ${index + 1} has no label.` });
    if (!isSafeCmsUrl(button.url)) issues.push({ id: `${blockId}-url`, blockId, severity: "error", message: `Button ${index + 1} has an empty or unsafe link.` });
  });
  page.blocks.forEach((block) => {
    const content = block.content;
    if (block.block_type === "image" && !String(content.alt ?? "").trim()) {
      issues.push({ id: `${block.id}-alt`, blockId: block.id, severity: "warning", message: "Image is missing alternative text." });
    }
    if (["button", "download_button", "submit_button"].includes(block.block_type) && !String(content.label ?? content.button_text ?? "").trim()) {
      issues.push({ id: `${block.id}-label`, blockId: block.id, severity: "error", message: "Button is empty." });
    }
    for (const key of ["url", "href", "target_url", "video_url"] as const) {
      const value = content[key];
      if (typeof value === "string" && value && !isSafeCmsUrl(value)) {
        issues.push({ id: `${block.id}-${key}`, blockId: block.id, severity: "error", message: `${key.replace(/_/g, " ")} is unsafe or invalid.` });
      }
    }
    if (["text_input", "email_input", "phone_input", "text_area", "dropdown", "radio_group", "checkbox_group"].includes(block.block_type) && !String(content.label ?? "").trim()) {
      issues.push({ id: `${block.id}-form-label`, blockId: block.id, severity: "error", message: "Form control is missing a label." });
    }
  });
  Object.entries(page.element_overrides ?? {}).forEach(([key, override]) => {
    if (!override.hidden && typeof override.href === "string" && !isSafeCmsUrl(override.href)) {
      issues.push({ id: `element-${key}-href`, blockId: `element:${key}`, severity: "error", message: "Link is empty, unsafe or invalid." });
    }
  });
  return issues;
}
