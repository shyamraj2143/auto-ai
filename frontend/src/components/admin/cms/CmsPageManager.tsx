import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArrowDown, ArrowUp, Copy, Eye, EyeOff, Plus, RefreshCw, RotateCcw, Save, Send, Trash2 } from "lucide-react";
import { ApiClientError, resolveApiAssetUrl } from "../../../api/client";
import { useAuth } from "../../../contexts/AuthContext";
import { cmsApi } from "./cmsApi";
import type { CmsBlock, CmsBlockType, CmsPage } from "./types";

type PageMode = "pages" | "seo" | "drafts";
type SaveState = "idle" | "saving" | "saved" | "failed" | "conflict";
type PreviewSize = "desktop" | "tablet" | "mobile";

const blockTypes: CmsBlockType[] = [
  "heading", "paragraph", "rich_text", "image", "video_link", "button", "feature_card",
  "feature_grid", "faq", "testimonial", "pricing_description", "call_to_action", "divider",
  "spacer", "download_button", "announcement_banner"
];

function label(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string | null) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not published";
}

function CmsStatusBadge({ status }: { status: CmsPage["status"] }) {
  return <span className={`cms-status cms-status-${status}`}>{label(status)}</span>;
}

function BlockPreview({ block }: { block: CmsBlock }) {
  const text = String(block.content.text ?? block.content.heading ?? block.content.title ?? block.content.label ?? "");
  if (block.block_type === "divider") return <hr className="border-white/15" />;
  if (block.block_type === "spacer") return <div className="h-8" aria-hidden="true" />;
  if (block.block_type === "image") {
    const url = String(block.content.url ?? block.content.image_url ?? "");
    return url ? <img className="max-h-48 w-full rounded object-cover" src={resolveApiAssetUrl(url)} alt={String(block.content.alt ?? "")} /> : <p>Image URL not set</p>;
  }
  if (block.block_type === "heading") return <h3 className="text-xl font-semibold text-white">{text}</h3>;
  if (["button", "download_button"].includes(block.block_type)) return <span className="btn-primary inline-flex">{text || "Button"}</span>;
  return <p className="whitespace-pre-wrap text-sm text-slate-300">{text || label(block.block_type)}</p>;
}

export function CmsPageManager({ mode, canEdit, canPublish }: { mode: PageMode; canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [selected, setSelected] = useState<CmsPage | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState(mode === "drafts" ? "draft" : "");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<CmsPage | null>(null);
  const [previewSize, setPreviewSize] = useState<PreviewSize>("desktop");
  const [previewBlockId, setPreviewBlockId] = useState<string | null>(null);
  const [newBlockType, setNewBlockType] = useState<CmsBlockType>("paragraph");
  const [lastDeletedBlock, setLastDeletedBlock] = useState<string | null>(null);
  const [publishSummary, setPublishSummary] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [conflictServer, setConflictServer] = useState<CmsPage | null>(null);
  const [showConflictCompare, setShowConflictCompare] = useState(false);
  const latestRef = useRef<CmsPage | null>(null);

  useEffect(() => { latestRef.current = selected; }, [selected]);
  useEffect(() => { setStatusFilter(mode === "drafts" ? "draft" : ""); }, [mode]);

  const loadPages = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await cmsApi.pages(token, query, statusFilter);
      setPages(result.items);
      setError("");
      if (latestRef.current) {
        const current = result.items.find((item) => item.id === latestRef.current?.id);
        if (!current && mode === "drafts") setSelected(null);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load pages");
    } finally {
      setLoading(false);
    }
  }, [mode, query, statusFilter, token]);

  useEffect(() => { void loadPages(); }, [loadPages]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const updatePageList = useCallback((page: CmsPage) => {
    setPages((current) => current.map((item) => item.id === page.id ? page : item));
  }, []);

  const saveNow = useCallback(async (): Promise<CmsPage | null> => {
    const page = latestRef.current;
    if (!token || !page || !canEdit) return page;
    setSaveState("saving");
    setError("");
    try {
      const saved = await cmsApi.saveDraft(token, page);
      setSelected(saved);
      latestRef.current = saved;
      updatePageList(saved);
      setDirty(false);
      setSaveState("saved");
      localStorage.removeItem(`auto-ai-cms-recovery:${saved.id}`);
      return saved;
    } catch (requestError) {
      localStorage.setItem(`auto-ai-cms-recovery:${page.id}`, JSON.stringify(page));
      if (requestError instanceof ApiClientError && requestError.status === 409) {
        setSaveState("conflict");
        setError("A newer server version exists. Your local draft is preserved. Compare or reload before saving again.");
        void cmsApi.page(token, page.id).then(setConflictServer).catch(() => undefined);
      } else {
        setSaveState("failed");
        setError(requestError instanceof Error ? requestError.message : "Autosave failed. Local draft preserved.");
      }
      return null;
    }
  }, [canEdit, token, updatePageList]);

  useEffect(() => {
    if (!dirty || !selected || !canEdit) return;
    setSaveState("idle");
    const timer = window.setTimeout(() => { void saveNow(); }, 1200);
    return () => window.clearTimeout(timer);
  }, [canEdit, dirty, saveNow, selected]);

  function mutatePage(mutator: (page: CmsPage) => CmsPage) {
    setSelected((current) => {
      if (!current) return current;
      const next = mutator(current);
      latestRef.current = next;
      return next;
    });
    setDirty(true);
    setMessage("");
  }

  async function openPage(page: CmsPage) {
    if (!token) return;
    if (dirty && !window.confirm("Leave this page editor? Unsaved local changes will remain in recovery storage.")) return;
    setLoading(true);
    try {
      const detail = await cmsApi.page(token, page.id);
      setSelected(detail);
      latestRef.current = detail;
      setDirty(false);
      setSaveState("idle");
      setError("");
      setLastDeletedBlock(null);
      setPreviewBlockId(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to open page");
    } finally {
      setLoading(false);
    }
  }

  async function withSavedPage(action: (page: CmsPage) => Promise<CmsPage>) {
    const source = dirty ? await saveNow() : selected;
    if (!source) return;
    try {
      const result = await action(source);
      setSelected(result);
      latestRef.current = result;
      updatePageList(result);
      setDirty(false);
      setError("");
      return result;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Content action failed");
    }
  }

  async function addBlock() {
    if (!token) return;
    await withSavedPage((page) => cmsApi.addBlock(token, page, newBlockType));
  }

  async function blockAction(block: CmsBlock, action: "duplicate" | "delete" | "toggle") {
    if (!token) return;
    if (action === "delete" && !window.confirm("Delete this block from the draft? You can restore it before publishing.")) return;
    const result = await withSavedPage((page) => {
      if (action === "duplicate") return cmsApi.duplicateBlock(token, page, block.id);
      if (action === "delete") return cmsApi.deleteBlock(token, page, block.id);
      return cmsApi.updateBlock(token, page, block.id, { is_visible: !block.is_visible });
    });
    if (result && action === "delete") setLastDeletedBlock(block.id);
  }

  async function updateBlock(block: CmsBlock, content: CmsBlock["content"]) {
    if (!token) return;
    await withSavedPage((page) => cmsApi.updateBlock(token, page, block.id, { content }));
  }

  async function moveBlock(index: number, direction: -1 | 1) {
    if (!token || !selected) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= selected.blocks.length) return;
    const ids = selected.blocks.map((item) => item.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    await withSavedPage((page) => cmsApi.reorderBlocks(token, page, ids));
  }

  async function restoreDeletedBlock(blockId = lastDeletedBlock) {
    if (!token || !blockId) return;
    const restored = await withSavedPage((page) => cmsApi.restoreBlock(token, page, blockId));
    if (restored) setLastDeletedBlock(null);
  }

  async function showPreview() {
    if (!token || !selected) return;
    const source = dirty ? await saveNow() : selected;
    if (!source) return;
    try {
      const result = await cmsApi.preview(token, source.id);
      setPreview(result.preview);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Preview failed");
    }
  }

  async function publish() {
    if (!token || !selected || !canPublish) return;
    const result = await withSavedPage((page) => cmsApi.publish(token, page, publishSummary || "Published from Content Manager", scheduledAt ? new Date(scheduledAt).toISOString() : null));
    if (result) {
      setPublishSummary("");
      setScheduledAt("");
      setMessage(result.status === "scheduled" ? "Publishing scheduled." : "Published successfully. Public cache was refreshed.");
    }
  }

  async function pageAction(action: "unpublish" | "archive") {
    if (!token || !selected || !canPublish || !window.confirm(`${label(action)} this page?`)) return;
    const result = await withSavedPage((page) => cmsApi.pageAction(token, page, action));
    if (result) setMessage(`${label(action)} completed.`);
  }

  async function reloadServerVersion() {
    if (!token || !selected) return;
    const local = latestRef.current;
    const server = await cmsApi.page(token, selected.id);
    if (local) localStorage.setItem(`auto-ai-cms-recovery:${local.id}`, JSON.stringify(local));
    setSelected(server); latestRef.current = server; setDirty(false); setSaveState("idle"); setConflictServer(null); setShowConflictCompare(false); setError("");
  }

  const previewWidth = previewSize === "desktop" ? "100%" : previewSize === "tablet" ? "768px" : "390px";
  const visiblePages = useMemo(() => pages, [pages]);

  return (
    <section aria-labelledby="cms-pages-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="cms-pages-title" className="text-lg font-semibold text-white">{mode === "seo" ? "SEO Settings" : mode === "drafts" ? "Drafts" : "Website Pages"}</h2>
          <p className="text-sm text-slate-400">Published content updates without a frontend redeploy. Source text remains the fallback.</p>
        </div>
        <button className="btn-secondary" onClick={() => void loadPages()} type="button"><RefreshCw size={15} /> Refresh</button>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
        <input className="text-input-dark h-10" aria-label="Search pages" placeholder="Search pages or slugs" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select className="model-select-dark h-10" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">All statuses</option><option value="draft">Draft</option><option value="published">Published</option><option value="scheduled">Scheduled</option><option value="archived">Archived</option>
        </select>
      </div>

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded border border-red-300/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">
          <span>{error}</span>{saveState === "conflict" && <div className="flex gap-2"><button className="chip-dark" disabled={!conflictServer} onClick={() => setShowConflictCompare((value) => !value)} type="button">Compare</button><button className="chip-dark" onClick={() => void reloadServerVersion()} type="button">Reload server version</button></div>}
        </div>
      )}
      {showConflictCompare && conflictServer && selected && <div className="mb-4 grid gap-3 rounded border border-amber-300/20 bg-amber-500/5 p-3 md:grid-cols-2"><div><strong className="text-xs uppercase text-amber-200">Local recovery</strong><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify({ title: selected.title, slug: selected.slug, hero_heading: selected.hero_heading, hero_description: selected.hero_description, version: selected.version }, null, 2)}</pre></div><div><strong className="text-xs uppercase text-cyan-200">Server version</strong><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify({ title: conflictServer.title, slug: conflictServer.slug, hero_heading: conflictServer.hero_heading, hero_description: conflictServer.hero_description, version: conflictServer.version }, null, 2)}</pre></div></div>}
      {message && <p className="mb-4 rounded border border-emerald-300/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{message}</p>}

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="max-h-[720px] overflow-y-auto border-r border-white/10 pr-3">
          {loading && !visiblePages.length ? <p className="p-3 text-sm text-slate-400">Loading pages...</p> : visiblePages.map((page) => (
            <button key={page.id} className={selected?.id === page.id ? "cms-page-row cms-page-row-active" : "cms-page-row"} onClick={() => void openPage(page)} type="button">
              <span className="min-w-0"><strong className="block truncate text-sm text-white">{page.title}</strong><small className="block truncate text-slate-400">/{page.slug === "home" ? "" : page.slug}</small></span>
              <span className="text-right"><CmsStatusBadge status={page.status} /><small className="mt-1 block text-[10px] text-slate-500">{formatDate(page.updated_at)}</small></span>
            </button>
          ))}
          {!loading && !visiblePages.length && <p className="p-3 text-sm text-slate-400">No pages match this filter.</p>}
        </div>

        {!selected ? (
          <div className="grid min-h-64 place-items-center border border-dashed border-white/15 text-sm text-slate-400">Select a page to edit.</div>
        ) : (
          <div className="min-w-0 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
              <div className="flex items-center gap-2"><CmsStatusBadge status={selected.status} /><span className="text-xs text-slate-400">Version {selected.version}</span><span className={`text-xs ${saveState === "failed" || saveState === "conflict" ? "text-red-300" : "text-slate-400"}`}>{saveState === "saving" ? "Saving..." : dirty ? "Unsaved" : saveState === "saved" ? "Saved" : ""}</span></div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => void showPreview()} type="button"><Eye size={15} /> Preview</button>
                {canEdit && <button className="btn-secondary" disabled={!dirty || saveState === "saving"} onClick={() => void saveNow()} type="button"><Save size={15} /> Save draft</button>}
              </div>
            </div>

            {mode !== "seo" && (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="cms-field"><span>Page title</span><input disabled={!canEdit} value={selected.title} onChange={(event) => mutatePage((page) => ({ ...page, title: event.target.value }))} /></label>
                  <label className="cms-field"><span>Slug</span><input disabled={!canEdit} value={selected.slug} onChange={(event) => mutatePage((page) => ({ ...page, slug: event.target.value }))} /></label>
                  <label className="cms-field md:col-span-2"><span>Hero heading</span><input disabled={!canEdit} value={selected.hero_heading} onChange={(event) => mutatePage((page) => ({ ...page, hero_heading: event.target.value }))} /></label>
                  <label className="cms-field md:col-span-2"><span>Hero description</span><textarea disabled={!canEdit} rows={4} value={selected.hero_description} onChange={(event) => mutatePage((page) => ({ ...page, hero_description: event.target.value }))} /></label>
                </div>
                <div className="border-t border-white/10 pt-4">
                  <div className="mb-3 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-white">Hero buttons and links</h3>{canEdit && <button className="btn-secondary" disabled={selected.buttons.length >= 8} onClick={() => mutatePage((page) => ({ ...page, buttons: [...page.buttons, { label: "New button", url: "/register", style: "primary" }] }))} type="button"><Plus size={15} /> Add button</button>}</div>
                  <div className="space-y-2">{selected.buttons.map((button, index) => <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px_auto]" key={index}><label className="cms-field"><span>Label</span><input disabled={!canEdit} value={button.label} onChange={(event) => mutatePage((page) => ({ ...page, buttons: page.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} /></label><label className="cms-field"><span>URL</span><input disabled={!canEdit} value={button.url} onChange={(event) => mutatePage((page) => ({ ...page, buttons: page.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, url: event.target.value } : item) }))} /></label><label className="cms-field"><span>Style</span><select disabled={!canEdit} value={button.style} onChange={(event) => mutatePage((page) => ({ ...page, buttons: page.buttons.map((item, itemIndex) => itemIndex === index ? { ...item, style: event.target.value as "primary" | "secondary" } : item) }))}><option value="primary">Primary</option><option value="secondary">Secondary</option></select></label>{canEdit && <button className="icon-button-dark self-end text-red-200" aria-label={`Delete ${button.label} button`} onClick={() => mutatePage((page) => ({ ...page, buttons: page.buttons.filter((_, itemIndex) => itemIndex !== index) }))} type="button"><Trash2 size={15} /></button>}</div>)}</div>
                </div>
              </div>
            )}

            {mode !== "seo" && (
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-white">Page blocks</h3><p className="text-xs text-slate-400">Use arrow controls for accessible reordering.</p></div>{canEdit && <div className="flex gap-2"><select className="model-select-dark" value={newBlockType} onChange={(event) => setNewBlockType(event.target.value as CmsBlockType)}>{blockTypes.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select><button className="btn-secondary" onClick={() => void addBlock()} type="button"><Plus size={15} /> Add block</button></div>}</div>
                <div className="space-y-2">
                  {selected.blocks.map((block, index) => (
                    <article key={block.id} className="cms-block-editor">
                      <header className="flex flex-wrap items-center justify-between gap-2"><div><strong className="text-sm text-white">{label(block.block_type)}</strong><span className="ml-2 text-xs text-slate-500">#{index + 1}</span></div><div className="flex gap-1"><button className="icon-button-dark" aria-label="Preview block" aria-pressed={previewBlockId === block.id} onClick={() => setPreviewBlockId((current) => current === block.id ? null : block.id)} type="button"><Eye size={15} /></button>{canEdit && <><button className="icon-button-dark" aria-label="Move block up" disabled={index === 0} onClick={() => void moveBlock(index, -1)} type="button"><ArrowUp size={15} /></button><button className="icon-button-dark" aria-label="Move block down" disabled={index === selected.blocks.length - 1} onClick={() => void moveBlock(index, 1)} type="button"><ArrowDown size={15} /></button><button className="icon-button-dark" aria-label={block.is_visible ? "Hide block" : "Show block"} onClick={() => void blockAction(block, "toggle")} type="button">{block.is_visible ? <EyeOff size={15} /> : <Eye size={15} />}</button><button className="icon-button-dark" aria-label="Duplicate block" onClick={() => void blockAction(block, "duplicate")} type="button"><Copy size={15} /></button><button className="icon-button-dark text-red-200" aria-label="Delete block" onClick={() => void blockAction(block, "delete")} type="button"><Trash2 size={15} /></button></>}</div></header>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {Object.entries(block.content).map(([key, value]) => (
                          <label key={key} className="cms-field"><span>{label(key)}</span><textarea disabled={!canEdit} rows={key.includes("description") || key === "text" ? 3 : 1} value={Array.isArray(value) ? JSON.stringify(value) : String(value ?? "")} onBlur={(event) => void updateBlock(block, { ...block.content, [key]: event.target.value })} onChange={(event) => setSelected((page) => page ? { ...page, blocks: page.blocks.map((item) => item.id === block.id ? { ...item, content: { ...item.content, [key]: event.target.value } } : item) } : page)} /></label>
                        ))}
                      </div>
                      {previewBlockId === block.id && <div className="mt-3 rounded border border-cyan-200/20 bg-slate-950/55 p-4" aria-label={`${label(block.block_type)} block preview`}><BlockPreview block={block} /></div>}
                      {!block.is_visible && <p className="mt-2 text-xs text-amber-200">Hidden blocks remain in the draft but are omitted from public rendering.</p>}
                    </article>
                  ))}
                </div>
                {lastDeletedBlock && canEdit && <button className="mt-3 btn-secondary" onClick={() => void restoreDeletedBlock()} type="button"><RotateCcw size={15} /> Undo last delete</button>}
                {Boolean(selected.deleted_blocks?.length) && <div className="mt-4 border-t border-white/10 pt-3"><h4 className="text-xs font-semibold uppercase text-slate-400">Deleted draft blocks</h4><div className="mt-2 flex flex-wrap gap-2">{selected.deleted_blocks?.map((block) => <button className="chip-dark" disabled={!canEdit} key={block.id} onClick={() => void restoreDeletedBlock(block.id)} type="button"><RotateCcw size={13} /> Restore {label(block.block_type)}</button>)}</div></div>}
              </div>
            )}

            <div className="border-t border-white/10 pt-4">
              <h3 className="mb-3 text-sm font-semibold text-white">SEO</h3>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="cms-field md:col-span-2"><span>SEO title ({selected.seo.title.length}/70)</span><input disabled={!canEdit} maxLength={70} value={selected.seo.title} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, title: event.target.value } }))} /></label>
                <label className="cms-field md:col-span-2"><span>Meta description ({selected.seo.description.length}/180)</span><textarea disabled={!canEdit} maxLength={180} rows={3} value={selected.seo.description} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, description: event.target.value } }))} /></label>
                <label className="cms-field md:col-span-2"><span>Open Graph title ({selected.seo.og_title.length}/100)</span><input disabled={!canEdit} maxLength={100} value={selected.seo.og_title} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, og_title: event.target.value } }))} /></label>
                <label className="cms-field md:col-span-2"><span>Open Graph description ({selected.seo.og_description.length}/220)</span><textarea disabled={!canEdit} maxLength={220} rows={3} value={selected.seo.og_description} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, og_description: event.target.value } }))} /></label>
                <label className="cms-field"><span>Canonical URL</span><input disabled={!canEdit} value={selected.seo.canonical_url} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, canonical_url: event.target.value } }))} /></label>
                <label className="cms-field"><span>Open Graph image</span><input disabled={!canEdit} value={selected.seo.og_image} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, og_image: event.target.value } }))} /></label>
                <label className="cms-check"><input disabled={!canEdit} type="checkbox" checked={selected.seo.robots_index} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, robots_index: event.target.checked } }))} /> Allow search indexing</label>
                <label className="cms-check"><input disabled={!canEdit} type="checkbox" checked={selected.seo.sitemap} onChange={(event) => mutatePage((page) => ({ ...page, seo: { ...page.seo, sitemap: event.target.checked } }))} /> Include in sitemap</label>
              </div>
              <div className="mt-4 rounded border border-white/10 bg-slate-950/45 p-4"><p className="text-lg text-cyan-200">{selected.seo.title || selected.title}</p><p className="text-xs text-emerald-300">{selected.seo.canonical_url || `https://autoai.site.je/${selected.slug}`}</p><p className="mt-1 text-sm text-slate-300">{selected.seo.description || selected.hero_description}</p></div>
            </div>

            {canPublish && (
              <div className="border-t border-white/10 pt-4">
                <h3 className="mb-3 text-sm font-semibold text-white">Publishing</h3>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]"><input className="text-input-dark" placeholder="Change summary" value={publishSummary} onChange={(event) => setPublishSummary(event.target.value)} /><input className="text-input-dark" aria-label="Schedule publishing" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /><button className="btn-primary" onClick={() => void publish()} type="button"><Send size={15} /> {scheduledAt ? "Schedule" : "Publish"}</button></div>
                <div className="mt-3 flex flex-wrap gap-2">{selected.status === "published" && <button className="btn-secondary" onClick={() => void pageAction("unpublish")} type="button">Unpublish</button>}<button className="btn-secondary" onClick={() => void pageAction("archive")} type="button"><Archive size={15} /> Archive</button><span className="self-center text-xs text-slate-400">Last published: {formatDate(selected.published_at)}</span></div>
              </div>
            )}
          </div>
        )}
      </div>

      {preview && (
        <div className="cms-preview-overlay" role="dialog" aria-modal="true" aria-label="Draft preview">
          <div className="cms-preview-dialog">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 p-3"><div className="flex gap-2">{(["desktop", "tablet", "mobile"] as PreviewSize[]).map((size) => <button key={size} className={previewSize === size ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => setPreviewSize(size)} type="button">{label(size)}</button>)}</div><button className="btn-secondary" onClick={() => setPreview(null)} type="button">Close</button></header>
            <div className="overflow-auto bg-slate-950 p-4"><div className="mx-auto min-h-[560px] max-w-full border border-white/10 bg-[#0b1020] p-6 transition-[width]" style={{ width: previewWidth }}><p className="text-xs uppercase text-cyan-200">Draft preview</p><h1 className="mt-3 text-3xl font-semibold text-white">{preview.hero_heading}</h1><p className="mt-3 text-slate-300">{preview.hero_description}</p><div className="mt-8 space-y-4">{(preview.blocks ?? []).filter((block) => block.is_visible).map((block) => <div key={block.id}><BlockPreview block={block} /></div>)}</div></div></div>
          </div>
        </div>
      )}
    </section>
  );
}
