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

function normalizeCmsUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("#")) return trimmed;
  if (/^(https?|mailto|tel):/i.test(trimmed)) return trimmed;

  // Normalize the URL forms that people commonly type into the visual editor
  // without a scheme. Unsafe schemes are deliberately left untouched so the
  // backend security validator can reject them instead of silently changing
  // potentially dangerous content.
  if (
    /^(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed) ||
    /^localhost(?::\d+)?(?:[/?#].*)?$/i.test(trimmed) ||
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#].*)?$/.test(trimmed)
  ) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function normalizeContentUrls(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    return ["url", "href", "image_url", "video_url", "target_url"].includes(key) ? normalizeCmsUrl(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeContentUrls(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, normalizeContentUrls(childValue, childKey)])
    );
  }
  return value;
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
    buttons: page.buttons.map((button) => ({
      ...button,
      url: normalizeCmsUrl(button.url)
    })),
    element_overrides: Object.fromEntries(
      Object.entries(page.element_overrides ?? {}).map(([key, override]) => [
        key,
        { ...override, ...(override.href != null ? { href: normalizeCmsUrl(override.href) } : {}) }
      ])
    ),
    seo: {
      ...page.seo,
      canonical_url: normalizeCmsUrl(page.seo.canonical_url),
      og_image: normalizeCmsUrl(page.seo.og_image)
    },
    blocks: page.blocks.map((block) => ({
      ...(block.id.startsWith("local-") ? {} : { id: block.id }),
      block_type: block.block_type,
      content: normalizeContentUrls(jsonObject(block.content as Record<string, unknown>)) as Record<string, unknown>,
      is_visible: block.is_visible
    }))
  };
}
