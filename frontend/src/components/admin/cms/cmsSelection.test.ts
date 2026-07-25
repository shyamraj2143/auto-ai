import { describe, expect, it } from "vitest";
import { cleanInlineText, isSafeCmsUrl, selectionKey } from "./cmsSelection";
import { validateCmsPage } from "./cmsValidation";
import type { CmsPage } from "./types";

function page(): CmsPage {
  return {
    id: "page", page_key: "home", title: "Home", slug: "home", status: "draft",
    hero_heading: "Hello", hero_description: "World", buttons: [{ label: "Start", url: "/register", style: "primary" }],
    element_overrides: {},
    seo: { title: "Home", description: "", canonical_url: "", og_title: "", og_description: "", og_image: "", robots_index: true, sitemap: true },
    blocks: [], version: 1, created_at: "", updated_at: ""
  };
}

describe("CMS cursor selection helpers", () => {
  it("builds stable field selection keys", () => expect(selectionKey("hero", "heading")).toBe("hero::heading"));
  it("normalizes pasted plain text", () => expect(cleanInlineText("  Safe\u00a0text\r\n  ")).toBe("Safe text"));
  it("rejects unsafe and protocol-relative links", () => {
    expect(isSafeCmsUrl("/pricing")).toBe(true);
    expect(isSafeCmsUrl("https://autoai.site.je")).toBe(true);
    expect(isSafeCmsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeCmsUrl("//evil.example")).toBe(false);
    expect(isSafeCmsUrl(null)).toBe(false);
  });
  it("accepts nullable element links returned by the API", () => {
    const draft = page();
    draft.element_overrides["footer.brand"] = { text: "Auto-AI", href: null };
    expect(validateCmsPage(draft)).toEqual([]);
  });
  it("reports publish-blocking link errors and accessibility warnings", () => {
    const draft = page();
    draft.buttons[0].url = "javascript:alert(1)";
    draft.element_overrides["footer.brand"] = { text: "Auto-AI", href: "javascript:alert(1)" };
    draft.blocks.push({ id: "image", block_type: "image", content: { image_url: "/image.png", alt: "" }, position: 0, is_visible: true });
    const issues = validateCmsPage(draft);
    expect(issues.some((issue) => issue.severity === "error" && issue.blockId === "page-button-0")).toBe(true);
    expect(issues.some((issue) => issue.severity === "warning" && issue.blockId === "image")).toBe(true);
    expect(issues.some((issue) => issue.severity === "error" && issue.blockId === "element:footer.brand")).toBe(true);
  });
});
