import { apiFetch, ApiClientError } from "../../../api/client";
import type { CmsAiAction, CmsAiSuggestion, CmsAnnouncement, CmsAudit, CmsBlockType, CmsFaq, CmsMedia, CmsPage, CmsPageResult, CmsRevision, CmsTextEntry } from "./types";
import { defaultBlockContent } from "./cmsBlockLibrary";
import { serializeCmsDraftForApi } from "./cmsDraft";

const root = "/admin/cms";

function pageKeyFromSlug(slug: string) {
  const key = slug.replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return /^[a-z]/.test(key) ? key : `page-${key || "new"}`;
}

export function shouldRetryCmsDraftSave(error: unknown) {
  if (!(error instanceof ApiClientError)) return false;
  if (error.status === undefined) {
    return ["network_unavailable", "cors_blocked", "server_unreachable"].includes(error.kind);
  }
  return error.status === 429 || (error.status >= 500 && error.status !== 504);
}

export async function withCmsDraftRetry<T>(operation: () => Promise<T>, backoffMs = 250): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!shouldRetryCmsDraftSave(error)) throw error;
    if (backoffMs > 0) await new Promise((resolve) => globalThis.setTimeout(resolve, backoffMs));
    return operation();
  }
}

export const cmsApi = {
  summary: (token: string) => apiFetch<Record<string, number>>(`${root}/summary`, { token, operation: "cms.summary" }),
  aiAssist: (token: string, action: CmsAiAction, text: string) => apiFetch<CmsAiSuggestion>(`${root}/ai-assist`, {
    method: "POST", token, operation: "cms.ai-assist", body: JSON.stringify({ action, text })
  }),
  pages: (token: string, search = "", status = "") => apiFetch<CmsPageResult<CmsPage>>(`${root}/pages?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`, { token, operation: "cms.pages" }),
  createPage: (token: string, title: string, slug: string) => apiFetch<CmsPage>(`${root}/pages`, {
    method: "POST", token, operation: "cms.page.create",
    body: JSON.stringify({
      page_key: pageKeyFromSlug(slug),
      title,
      slug,
      hero_heading: title,
      hero_description: "Add page description.",
      buttons: [],
      seo: {
        title,
        description: "",
        canonical_url: "",
        og_title: title,
        og_description: "",
        og_image: "/icons/icon-512.png",
        robots_index: true,
        sitemap: true
      }
    })
  }),
  page: (token: string, id: string) => apiFetch<CmsPage>(`${root}/pages/${id}`, { token, operation: "cms.page" }),
  updatePage: (token: string, page: CmsPage) => apiFetch<CmsPage>(`${root}/pages/${page.id}`, {
    method: "PATCH", token, operation: "cms.page.update",
    body: JSON.stringify({
      expected_version: page.version, title: page.title, slug: page.slug,
      hero_heading: page.hero_heading, hero_description: page.hero_description,
      buttons: page.buttons, element_overrides: page.element_overrides, seo: page.seo
    })
  }),
  saveDraft: (token: string, page: CmsPage) => withCmsDraftRetry(() => apiFetch<CmsPage>(`${root}/pages/${page.id}/draft`, {
    method: "PUT", token, operation: "cms.page.draft.save", body: JSON.stringify(serializeCmsDraftForApi(page))
  })),
  addBlock: (token: string, page: CmsPage, blockType: CmsBlockType) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks?expected_version=${page.version}`, {
    method: "POST", token, operation: "cms.block.create", body: JSON.stringify({ block_type: blockType, content: defaultBlockContent(blockType), is_visible: true })
  }),
  updateBlock: (token: string, page: CmsPage, blockId: string, payload: Record<string, unknown>) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks/${blockId}`, {
    method: "PATCH", token, operation: "cms.block.update", body: JSON.stringify({ ...payload, expected_page_version: page.version })
  }),
  duplicateBlock: (token: string, page: CmsPage, blockId: string) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks/${blockId}/duplicate?expected_version=${page.version}`, { method: "POST", token, operation: "cms.block.duplicate" }),
  deleteBlock: (token: string, page: CmsPage, blockId: string) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks/${blockId}?expected_version=${page.version}`, { method: "DELETE", token, operation: "cms.block.delete" }),
  restoreBlock: (token: string, page: CmsPage, blockId: string) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks/${blockId}/restore?expected_version=${page.version}`, { method: "POST", token, operation: "cms.block.restore" }),
  reorderBlocks: (token: string, page: CmsPage, ids: string[]) => apiFetch<CmsPage>(`${root}/pages/${page.id}/blocks/order`, { method: "PUT", token, operation: "cms.blocks.order", body: JSON.stringify({ block_ids: ids, expected_page_version: page.version }) }),
  preview: (token: string, id: string) => apiFetch<{ preview: CmsPage; version: number }>(`${root}/pages/${id}/preview`, { token, operation: "cms.preview" }),
  publish: (token: string, page: CmsPage, summary: string, scheduledAt?: string | null) => apiFetch<CmsPage>(`${root}/pages/${page.id}/publish`, { method: "POST", token, operation: "cms.publish", body: JSON.stringify({ expected_version: page.version, change_summary: summary, scheduled_at: scheduledAt || null }) }),
  pageAction: (token: string, page: CmsPage, action: "unpublish" | "archive") => apiFetch<CmsPage>(`${root}/pages/${page.id}/${action}`, { method: "POST", token, operation: `cms.${action}`, body: JSON.stringify({ expected_version: page.version, change_summary: action }) }),
  textEntries: (token: string, kind: "global-content" | "ui-text", search = "") => apiFetch<CmsTextEntry[]>(`${root}/${kind}?search=${encodeURIComponent(search)}`, { token, operation: `cms.${kind}` }),
  updateText: (token: string, kind: "global-content" | "ui-text", entry: CmsTextEntry, value: string) => apiFetch<CmsTextEntry>(`${root}/${kind}/${entry.id}`, { method: "PATCH", token, operation: `cms.${kind}.update`, body: JSON.stringify({ value, expected_version: entry.version }) }),
  textAction: (token: string, kind: "global-content" | "ui-text", entry: CmsTextEntry, action: "publish" | "reset") => apiFetch<CmsTextEntry>(`${root}/${kind}/${entry.id}/${action}`, { method: "POST", token, operation: `cms.${kind}.${action}`, body: JSON.stringify({ expected_version: entry.version, change_summary: action }) }),
  faqs: (token: string, search = "") => apiFetch<CmsFaq[]>(`${root}/faqs?search=${encodeURIComponent(search)}`, { token, operation: "cms.faqs" }),
  createFaq: (token: string) => apiFetch<CmsFaq>(`${root}/faqs`, { method: "POST", token, operation: "cms.faq.create", body: JSON.stringify({ question: "New question?", answer: "Add the answer.", category: "General", enabled: true, position: 0 }) }),
  updateFaq: (token: string, faq: CmsFaq) => apiFetch<CmsFaq>(`${root}/faqs/${faq.id}`, { method: "PATCH", token, operation: "cms.faq.update", body: JSON.stringify({ expected_version: faq.version, question: faq.question, answer: faq.answer, category: faq.category, enabled: faq.enabled, position: faq.position }) }),
  faqAction: (token: string, faq: CmsFaq, action: "publish" | "archive") => apiFetch<CmsFaq>(`${root}/faqs/${faq.id}/${action}`, { method: "POST", token, operation: `cms.faq.${action}`, body: JSON.stringify({ expected_version: faq.version, change_summary: action }) }),
  announcements: (token: string) => apiFetch<CmsAnnouncement[]>(`${root}/announcements`, { token, operation: "cms.announcements" }),
  createAnnouncement: (token: string) => apiFetch<CmsAnnouncement>(`${root}/announcements`, { method: "POST", token, operation: "cms.announcement.create", body: JSON.stringify({ title: "New announcement", message: "Announcement message", action_text: "", target_url: "", targets: "both", audience: "all", dismissible: true }) }),
  updateAnnouncement: (token: string, item: CmsAnnouncement) => apiFetch<CmsAnnouncement>(`${root}/announcements/${item.id}`, { method: "PATCH", token, operation: "cms.announcement.update", body: JSON.stringify({ ...item, expected_version: item.version, id: undefined, version: undefined, status: undefined, updated_at: undefined }) }),
  announcementAction: (token: string, item: CmsAnnouncement, action: "publish" | "archive") => apiFetch<CmsAnnouncement>(`${root}/announcements/${item.id}/${action}`, { method: "POST", token, operation: `cms.announcement.${action}`, body: JSON.stringify({ expected_version: item.version, change_summary: action }) }),
  media: (token: string, search = "") => apiFetch<CmsPageResult<CmsMedia>>(`${root}/media?search=${encodeURIComponent(search)}`, { token, operation: "cms.media" }),
  uploadMedia: (token: string, form: FormData) => apiFetch<CmsMedia>(`${root}/media`, { method: "POST", token, operation: "cms.media.upload", body: form }),
  updateMedia: (token: string, item: CmsMedia) => apiFetch<CmsMedia>(`${root}/media/${item.id}`, { method: "PATCH", token, operation: "cms.media.update", body: JSON.stringify({ alt_text: item.alt_text, caption: item.caption }) }),
  replaceMedia: (token: string, id: string, form: FormData) => apiFetch<CmsMedia>(`${root}/media/${id}/replace`, { method: "POST", token, operation: "cms.media.replace", body: form }),
  deleteMedia: (token: string, id: string) => apiFetch<void>(`${root}/media/${id}`, { method: "DELETE", token, operation: "cms.media.delete" }),
  revisions: (token: string, contentId = "") => apiFetch<CmsPageResult<CmsRevision>>(`${root}/revisions?content_id=${encodeURIComponent(contentId)}`, { token, operation: "cms.revisions" }),
  restoreRevision: (token: string, revision: CmsRevision, expectedVersion: number) => apiFetch<CmsPage>(`${root}/revisions/${revision.id}/restore`, { method: "POST", token, operation: "cms.revision.restore", body: JSON.stringify({ expected_version: expectedVersion, change_summary: `Restore revision ${revision.version}` }) }),
  audit: (token: string) => apiFetch<CmsPageResult<CmsAudit>>(`${root}/audit`, { token, operation: "cms.audit" })
};
