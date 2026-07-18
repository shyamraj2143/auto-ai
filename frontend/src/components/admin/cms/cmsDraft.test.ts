import { describe, expect, it } from "vitest";
import { serializeCmsDraftForApi } from "./cmsDraft";
import type { CmsPage } from "./types";

function page(): CmsPage {
  return {
    id: "page-1",
    page_key: "home",
    title: "Home",
    slug: "home",
    status: "draft",
    hero_heading: "Heading",
    hero_description: "Description",
    buttons: [{ label: "Start", url: "/register", style: "primary" }],
    element_overrides: { "footer.description": { text: "Footer" } },
    seo: { title: "Home", description: "", canonical_url: "", og_title: "", og_description: "", og_image: "", robots_index: true, sitemap: true },
    blocks: [
      { id: "server-block", block_type: "heading", content: { text: "Existing" }, position: 7, is_visible: true },
      { id: "local-123", block_type: "paragraph", content: { text: "New" }, position: 8, is_visible: false }
    ],
    version: 4,
    created_at: "created",
    updated_at: "updated"
  };
}

describe("CMS draft API serializer", () => {
  it("sends only the canonical persistable document fields", () => {
    const editorState = Object.assign(page(), {
      selected_block_id: "server-block",
      viewport: "mobile",
      history: ["runtime-only"],
      save_status: "Unsaved"
    });

    const payload = serializeCmsDraftForApi(editorState);

    expect(Object.keys(payload).sort()).toEqual([
      "blocks", "buttons", "element_overrides", "expected_version", "hero_description", "hero_heading",
      "page_id", "schema_version", "seo", "slug", "title"
    ]);
    expect(payload).not.toHaveProperty("selected_block_id");
    expect(payload).not.toHaveProperty("viewport");
    expect(payload).not.toHaveProperty("history");
    expect(payload.blocks[0]).toEqual({ id: "server-block", block_type: "heading", content: { text: "Existing" }, is_visible: true });
    expect(payload.blocks[1]).toEqual({ block_type: "paragraph", content: { text: "New" }, is_visible: false });
    expect(payload.blocks[0]).not.toHaveProperty("position");
  });
});
