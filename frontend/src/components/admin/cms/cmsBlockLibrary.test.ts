import { describe, expect, it } from "vitest";
import { cmsBlockDefinitionMap, cmsBlockDefinitions, defaultBlockContent, duplicateLocalBlock, makeLocalBlock } from "./cmsBlockLibrary";

describe("cmsBlockLibrary", () => {
  it("keeps every block definition addressable by type", () => {
    for (const definition of cmsBlockDefinitions) {
      expect(cmsBlockDefinitionMap[definition.type]).toBe(definition);
    }
  });

  it("creates safe default content for visual builder form and media blocks", () => {
    expect(defaultBlockContent("email_input")).toMatchObject({ label: "Email", required: true });
    expect(defaultBlockContent("image")).toMatchObject({ image_url: "", alt: "", caption: "" });
    expect(JSON.stringify(defaultBlockContent("button"))).not.toContain("javascript:");
  });

  it("creates local blocks and duplicates without reusing ids", () => {
    const block = makeLocalBlock("heading", 0);
    const copy = duplicateLocalBlock(block, 1);
    expect(block.id).toMatch(/^local-/);
    expect(copy.id).toMatch(/^local-/);
    expect(copy.id).not.toBe(block.id);
    expect(copy.position).toBe(1);
    expect(copy.content).toEqual(block.content);
  });
});
