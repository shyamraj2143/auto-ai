import type { CmsBlockType, CmsButton, CmsElementOverride, CmsPage, CmsSeo } from "./types";

export type CmsDraftBlockPayload = {
  id?: string;
  block_type: CmsBlockType;
  content: Record<string, unknown>;
  is_visible: boolean;
};

export type CmsDraftUpdatePayload = {
  schema_version: 1;
  page_id: string;
  expected_version: number;
  title: string;
  slug: string;
  hero_heading: string;
  hero_description: string;
  buttons: CmsButton[];
  element_overrides: Record<string, CmsElementOverride>;
  seo: CmsSeo;
  blocks: CmsDraftBlockPayload[];
};

function jsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function serializeCmsDraftForApi(page: CmsPage): CmsDraftUpdatePayload {
  return {
    schema_version: 1,
    page_id: page.id,
    expected_version: page.version,
    title: page.title,
    slug: page.slug,
    hero_heading: page.hero_heading,
    hero_description: page.hero_description,
    buttons: page.buttons.map((button) => ({ ...button })),
    element_overrides: Object.fromEntries(
      Object.entries(page.element_overrides ?? {}).map(([key, override]) => [key, { ...override }])
    ),
    seo: { ...page.seo },
    blocks: page.blocks.map((block) => ({
      ...(block.id.startsWith("local-") ? {} : { id: block.id }),
      block_type: block.block_type,
      content: jsonObject(block.content as Record<string, unknown>),
      is_visible: block.is_visible
    }))
  };
}
