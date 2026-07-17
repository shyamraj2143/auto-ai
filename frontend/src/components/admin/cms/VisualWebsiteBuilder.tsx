import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowUp, Copy, Eye, EyeOff, History, Monitor, PanelLeft,
  PanelRight, Plus, Redo2, RotateCcw, Save, Send, Smartphone, Tablet, Trash2
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiClientError } from "../../../api/client";
import { useAuth } from "../../../contexts/AuthContext";
import { CmsBlockRenderer } from "./CmsBlockRenderer";
import { cmsApi } from "./cmsApi";
import {
  cmsBlockDefinitionMap, cmsBlockDefinitions, defaultBlockContent, duplicateLocalBlock,
  labelCms, makeLocalBlock, type CmsDevice
} from "./cmsBlockLibrary";
import type { CmsBlock, CmsBlockType, CmsPage } from "./types";

type SaveState = "idle" | "saving" | "saved" | "failed" | "conflict";
type BuilderSection = "all-pages" | "create-page" | "drafts" | "seo";

const devices: Array<{ id: CmsDevice; icon: ReactNode; label: string }> = [
  { id: "desktop", icon: <Monitor size={15} />, label: "Desktop" },
  { id: "tablet", icon: <Tablet size={15} />, label: "Tablet" },
  { id: "mobile", icon: <Smartphone size={15} />, label: "Mobile" }
];

function makeSlug(title: string) {
  const slug = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "new-page";
}

function pageFromSnapshot(page: CmsPage): CmsPage {
  return JSON.parse(JSON.stringify(page)) as CmsPage;
}

export function VisualWebsiteBuilder({ section, canEdit, canPublish }: { section: BuilderSection; canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [selected, setSelected] = useState<CmsPage | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [device, setDevice] = useState<CmsDevice>("desktop");
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<CmsPage | null>(null);
  const [publishSummary, setPublishSummary] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [newPageTitle, setNewPageTitle] = useState("New Landing Page");
  const [history, setHistory] = useState<CmsPage[]>([]);
  const [future, setFuture] = useState<CmsPage[]>([]);
  const latestRef = useRef<CmsPage | null>(null);
  const routePageId = location.pathname.match(/\/admin\/website-builder\/pages\/([^/]+)$/)?.[1] ?? "";

  const statusFilter = section === "drafts" ? "draft" : "";
  const selectedBlock = selected?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const groupedBlocks = useMemo(() => {
    return cmsBlockDefinitions.reduce<Record<string, typeof cmsBlockDefinitions>>((groups, block) => {
      groups[block.category] = [...(groups[block.category] ?? []), block];
      return groups;
    }, {});
  }, []);

  const loadPages = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await cmsApi.pages(token, query, statusFilter);
      setPages(result.items);
      if ((!selected || (routePageId && selected.id !== routePageId)) && result.items[0] && section !== "create-page") {
        const target = routePageId ? result.items.find((item) => item.id === routePageId) : result.items[0];
        const detail = await cmsApi.page(token, target?.id ?? result.items[0].id);
        setSelected(detail);
        latestRef.current = detail;
      }
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load pages");
    } finally {
      setLoading(false);
    }
  }, [query, routePageId, section, selected, statusFilter, token]);

  useEffect(() => { void loadPages(); }, [loadPages]);
  useEffect(() => { latestRef.current = selected; }, [selected]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  function pushHistory(current: CmsPage) {
    setHistory((items) => [...items.slice(-29), pageFromSnapshot(current)]);
    setFuture([]);
  }

  function mutate(mutator: (page: CmsPage) => CmsPage) {
    if (!canEdit) return;
    setSelected((current) => {
      if (!current) return current;
      pushHistory(current);
      const next = mutator(pageFromSnapshot(current));
      latestRef.current = next;
      localStorage.setItem(`auto-ai-cms-recovery:${next.id}`, JSON.stringify(next));
      return next;
    });
    setDirty(true);
    setSaveState("idle");
    setMessage("");
  }

  async function openPage(page: CmsPage) {
    if (!token) return;
    if (dirty && !window.confirm("Open another page? Unsaved local work is preserved in browser recovery.")) return;
    setLoading(true);
    try {
      const detail = await cmsApi.page(token, page.id);
      const recovery = localStorage.getItem(`auto-ai-cms-recovery:${detail.id}`);
      const next = recovery && window.confirm("Recovered local edits exist for this page. Restore them?") ? JSON.parse(recovery) as CmsPage : detail;
      setSelected(next);
      navigate(`/admin/website-builder/pages/${detail.id}`);
      latestRef.current = next;
      setSelectedBlockId(next.blocks[0]?.id ?? null);
      setDirty(next !== detail);
      setHistory([]);
      setFuture([]);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to open page");
    } finally {
      setLoading(false);
    }
  }

  async function createPage() {
    if (!token || !canEdit) return;
    const title = newPageTitle.trim();
    if (!title) return;
    setLoading(true);
    try {
      const page = await cmsApi.createPage(token, title, makeSlug(title));
      setPages((items) => [page, ...items]);
      setSelected(page);
      latestRef.current = page;
      setSelectedBlockId(null);
      setDirty(false);
      setMessage("Page created.");
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create page");
    } finally {
      setLoading(false);
    }
  }

  async function saveNow(): Promise<CmsPage | null> {
    const page = latestRef.current;
    if (!token || !page || !canEdit) return page;
    setSaveState("saving");
    try {
      let next = await cmsApi.updatePage(token, page);
      const wantedServerIds = new Set(page.blocks.filter((block) => !block.id.startsWith("local-")).map((block) => block.id));
      for (const serverBlock of [...next.blocks]) {
        if (!wantedServerIds.has(serverBlock.id)) {
          next = await cmsApi.deleteBlock(token, next, serverBlock.id);
        }
      }
      for (const draftBlock of page.blocks.filter((block) => !block.id.startsWith("local-"))) {
        const serverBlock = next.blocks.find((block) => block.id === draftBlock.id);
        if (!serverBlock) continue;
        if (JSON.stringify(serverBlock.content) !== JSON.stringify(draftBlock.content) || serverBlock.is_visible !== draftBlock.is_visible) {
          next = await cmsApi.updateBlock(token, next, draftBlock.id, { content: draftBlock.content, is_visible: draftBlock.is_visible });
        }
      }
      const localCreated = new Map<string, string>();
      const localBlocks = page.blocks.filter((block) => block.id.startsWith("local-"));
      for (const localBlock of localBlocks) {
        next = await cmsApi.addBlock(token, next, localBlock.block_type);
        const created = next.blocks[next.blocks.length - 1];
        if (created) {
          next = await cmsApi.updateBlock(token, next, created.id, { content: localBlock.content, is_visible: localBlock.is_visible });
          localCreated.set(localBlock.id, created.id);
        }
      }
      if (localBlocks.length) {
        const desired = page.blocks.map((block) => block.id.startsWith("local-") ? localCreated.get(block.id) : block.id).filter(Boolean) as string[];
        if (desired.length === next.blocks.length) next = await cmsApi.reorderBlocks(token, next, desired);
      } else {
        const desired = page.blocks.map((block) => block.id);
        if (desired.length === next.blocks.length && desired.some((id, index) => next.blocks[index]?.id !== id)) {
          next = await cmsApi.reorderBlocks(token, next, desired);
        }
      }
      setSelected(next);
      latestRef.current = next;
      setPages((items) => items.map((item) => item.id === next.id ? next : item));
      setDirty(false);
      setSaveState("saved");
      localStorage.removeItem(`auto-ai-cms-recovery:${next.id}`);
      return next;
    } catch (requestError) {
      if (page) localStorage.setItem(`auto-ai-cms-recovery:${page.id}`, JSON.stringify(page));
      setSaveState(requestError instanceof ApiClientError && requestError.status === 409 ? "conflict" : "failed");
      setError(requestError instanceof Error ? requestError.message : "Save failed. Local edits are preserved.");
      return null;
    }
  }

  async function withSaved(action: (page: CmsPage) => Promise<CmsPage>) {
    const source = dirty ? await saveNow() : selected;
    if (!source) return;
    try {
      const next = await action(source);
      setSelected(next);
      latestRef.current = next;
      setPages((items) => items.map((item) => item.id === next.id ? next : item));
      setDirty(false);
      setError("");
      return next;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Action failed");
    }
  }

  function addLocalBlock(blockType: CmsBlockType) {
    mutate((page) => {
      const block = makeLocalBlock(blockType, page.blocks.length);
      setSelectedBlockId(block.id);
      return { ...page, blocks: [...page.blocks, block] };
    });
  }

  function updateBlockContent(blockId: string, key: string, value: string | number | boolean | unknown[] | null) {
    mutate((page) => ({ ...page, blocks: page.blocks.map((block) => block.id === blockId ? { ...block, content: { ...block.content, [key]: value } } : block) }));
  }

  function updatePageTextField(key: "hero_heading" | "hero_description", value: string) {
    mutate((page) => ({ ...page, [key]: value }));
  }

  function updatePageField(key: keyof CmsPage, value: unknown) {
    mutate((page) => ({ ...page, [key]: value }));
  }

  function moveBlock(index: number, direction: -1 | 1) {
    mutate((page) => {
      const next = [...page.blocks];
      const target = index + direction;
      if (target < 0 || target >= next.length) return page;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...page, blocks: next.map((block, position) => ({ ...block, position })) };
    });
  }

  function duplicateBlock(block: CmsBlock) {
    mutate((page) => {
      const index = page.blocks.findIndex((item) => item.id === block.id);
      const nextBlock = block.id.startsWith("local-") ? duplicateLocalBlock(block, index + 1) : duplicateLocalBlock(block, index + 1);
      setSelectedBlockId(nextBlock.id);
      const blocks = [...page.blocks.slice(0, index + 1), nextBlock, ...page.blocks.slice(index + 1)];
      return { ...page, blocks: blocks.map((item, position) => ({ ...item, position })) };
    });
  }

  function deleteBlock(blockId: string) {
    if (!window.confirm("Delete this block from the draft?")) return;
    mutate((page) => ({ ...page, blocks: page.blocks.filter((block) => block.id !== blockId).map((block, position) => ({ ...block, position })) }));
    setSelectedBlockId(null);
  }

  function undo() {
    if (!history.length || !selected) return;
    const previous = history[history.length - 1];
    setFuture((items) => [pageFromSnapshot(selected), ...items]);
    setHistory((items) => items.slice(0, -1));
    setSelected(previous);
    latestRef.current = previous;
    setDirty(true);
  }

  function redo() {
    if (!future.length || !selected) return;
    const next = future[0];
    setHistory((items) => [...items, pageFromSnapshot(selected)]);
    setFuture((items) => items.slice(1));
    setSelected(next);
    latestRef.current = next;
    setDirty(true);
  }

  async function showPreview() {
    const source = dirty ? await saveNow() : selected;
    if (!token || !source) return;
    const result = await cmsApi.preview(token, source.id);
    setPreview(result.preview);
  }

  async function publish() {
    if (!token || !canPublish) return;
    const next = await withSaved((page) => cmsApi.publish(token, page, publishSummary || "Published from Visual Builder", scheduledAt ? new Date(scheduledAt).toISOString() : null));
    if (next) {
      setPublishSummary("");
      setScheduledAt("");
      setMessage(next.status === "scheduled" ? "Publish scheduled." : "Published successfully.");
    }
  }

  const saveLabel = saveState === "saving" ? "Saving" : saveState === "failed" ? "Failed" : saveState === "conflict" ? "Conflict" : dirty ? "Unsaved" : saveState === "saved" ? "Saved" : "Saved";
  const canvasWidth = device === "desktop" ? "100%" : device === "tablet" ? "768px" : "390px";

  return (
    <section className="visual-builder" aria-label="Visual website builder">
      <header className="visual-builder-toolbar">
        <button className="chip-dark" onClick={() => { setSelected(null); navigate("/admin/website-builder/pages"); }} type="button"><ArrowLeft size={15} /> Back to Pages</button>
        <div className="min-w-0"><strong className="block truncate text-white">{selected?.title ?? "Website Builder"}</strong><span className={saveState === "failed" || saveState === "conflict" ? "text-red-300" : "text-slate-400"}>{saveLabel}</span></div>
        <div className="visual-builder-toolbar-actions">
          <button className="icon-button-dark" disabled={!history.length} aria-label="Undo" onClick={undo} type="button"><RotateCcw size={15} /></button>
          <button className="icon-button-dark" disabled={!future.length} aria-label="Redo" onClick={redo} type="button"><Redo2 size={15} /></button>
          {devices.map((item) => <button className={device === item.id ? "chip-dark chip-dark-active" : "chip-dark"} key={item.id} onClick={() => setDevice(item.id)} type="button">{item.icon}{item.label}</button>)}
          <button className="chip-dark" onClick={() => void showPreview()} type="button"><Eye size={15} /> Preview</button>
          {canEdit && <button className="btn-secondary" disabled={!dirty || saveState === "saving"} onClick={() => void saveNow()} type="button"><Save size={15} /> Save Draft</button>}
          {canPublish && <button className="btn-primary" onClick={() => void publish()} type="button"><Send size={15} /> {scheduledAt ? "Schedule" : "Publish"}</button>}
        </div>
      </header>

      {error && <div className="mb-3 rounded border border-red-300/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
      {message && <div className="mb-3 rounded border border-emerald-300/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{message}</div>}

      {section === "create-page" && !selected && (
        <div className="mb-4 grid gap-3 rounded-lg border border-white/10 bg-white/[0.045] p-4 md:grid-cols-[minmax(0,1fr)_180px]">
          <label className="cms-field"><span>Page name</span><input value={newPageTitle} onChange={(event) => setNewPageTitle(event.target.value)} /></label>
          <button className="btn-primary self-end" disabled={!canEdit || loading} onClick={() => void createPage()} type="button"><Plus size={15} /> Create Page</button>
        </div>
      )}

      <div className="visual-builder-layout">
        <aside className="visual-builder-panel">
          <div className="visual-panel-title"><PanelLeft size={15} /><span>Components</span></div>
          <input className="text-input-dark mb-3 h-10 w-full" placeholder="Search pages" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="visual-page-list">
            {pages.map((page) => (
              <button className={selected?.id === page.id ? "cms-page-row cms-page-row-active" : "cms-page-row"} key={page.id} onClick={() => void openPage(page)} type="button">
                <span><strong className="block truncate text-sm text-white">{page.title}</strong><small className="text-slate-400">/{page.slug === "home" ? "" : page.slug}</small></span>
                <span className={`cms-status cms-status-${page.status}`}>{page.status}</span>
              </button>
            ))}
          </div>
          {canEdit && selected && (
            <div className="mt-4 space-y-3">
              {Object.entries(groupedBlocks).map(([group, items]) => (
                <details open={group === "Sections" || group === "Basic"} key={group}>
                  <summary className="visual-layer-summary">{group}</summary>
                  <div className="mt-2 grid gap-2">
                    {items.map((block) => <button className="visual-component-button" key={block.type} onClick={() => addLocalBlock(block.type)} type="button"><Plus size={13} /> {block.label}</button>)}
                  </div>
                </details>
              ))}
            </div>
          )}
          {selected && (
            <div className="mt-4 border-t border-white/10 pt-3">
              <div className="visual-panel-title"><History size={15} /><span>Layers</span></div>
              <button className={!selectedBlockId ? "visual-layer-row visual-layer-row-active" : "visual-layer-row"} onClick={() => setSelectedBlockId(null)} type="button">Page</button>
              {selected.blocks.map((block, index) => (
                <div className={selectedBlockId === block.id ? "visual-layer-row visual-layer-row-active" : "visual-layer-row"} key={block.id}>
                  <button className="min-w-0 flex-1 truncate text-left" onClick={() => setSelectedBlockId(block.id)} type="button">{index + 1}. {cmsBlockDefinitionMap[block.block_type]?.label ?? labelCms(block.block_type)}</button>
                  {canEdit && <button aria-label="Hide block" onClick={() => mutate((page) => ({ ...page, blocks: page.blocks.map((item) => item.id === block.id ? { ...item, is_visible: !item.is_visible } : item) }))} type="button">{block.is_visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>}
                </div>
              ))}
            </div>
          )}
        </aside>

        <main className="visual-builder-canvas-wrap">
          {!selected ? (
            <div className="visual-builder-empty">Select or create a page.</div>
          ) : (
            <div className="visual-builder-canvas" style={{ width: canvasWidth }}>
              <CmsBlockRenderer
                blocks={selected.blocks}
                device={device}
                editMode={canEdit}
                onInlineChange={updateBlockContent}
                onPageFieldChange={updatePageTextField}
                onSelect={setSelectedBlockId}
                page={selected}
                selectedBlockId={selectedBlockId}
              />
            </div>
          )}
        </main>

        <aside className="visual-builder-panel">
          <div className="visual-panel-title"><PanelRight size={15} /><span>Properties</span></div>
          {selected && !selectedBlock && (
            <div className="space-y-3">
              <label className="cms-field"><span>Page title</span><input disabled={!canEdit} value={selected.title} onChange={(event) => updatePageField("title", event.target.value)} /></label>
              <label className="cms-field"><span>Slug</span><input disabled={!canEdit} value={selected.slug} onChange={(event) => updatePageField("slug", event.target.value)} /></label>
              <label className="cms-field"><span>Hero heading</span><input disabled={!canEdit} value={selected.hero_heading} onChange={(event) => updatePageField("hero_heading", event.target.value)} /></label>
              <label className="cms-field"><span>Hero description</span><textarea disabled={!canEdit} rows={4} value={selected.hero_description} onChange={(event) => updatePageField("hero_description", event.target.value)} /></label>
              <label className="cms-field"><span>SEO title</span><input disabled={!canEdit} maxLength={70} value={selected.seo.title} onChange={(event) => mutate((page) => ({ ...page, seo: { ...page.seo, title: event.target.value } }))} /></label>
              <label className="cms-field"><span>Meta description</span><textarea disabled={!canEdit} maxLength={180} value={selected.seo.description} onChange={(event) => mutate((page) => ({ ...page, seo: { ...page.seo, description: event.target.value } }))} /></label>
              {canPublish && <><label className="cms-field"><span>Change summary</span><input value={publishSummary} onChange={(event) => setPublishSummary(event.target.value)} /></label><label className="cms-field"><span>Schedule</span><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></label></>}
            </div>
          )}
          {selectedBlock && (
            <div className="space-y-3">
              <div className="rounded border border-white/10 bg-white/[0.04] p-3">
                <strong className="text-white">{cmsBlockDefinitionMap[selectedBlock.block_type]?.label ?? labelCms(selectedBlock.block_type)}</strong>
                <p className="text-xs text-slate-400">Page &gt; {selectedBlock.block_type}</p>
              </div>
              {(cmsBlockDefinitionMap[selectedBlock.block_type]?.fields ?? []).map((field) => (
                <label className="cms-field" key={field.key}>
                  <span>{field.label}</span>
                  {field.type === "select" ? (
                    <select disabled={!canEdit} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, event.target.value)}>
                      {(field.options ?? []).map((option) => <option key={option} value={option}>{labelCms(option)}</option>)}
                    </select>
                  ) : field.type === "boolean" ? (
                    <input disabled={!canEdit} checked={Boolean(selectedBlock.content[field.key])} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, event.target.checked)} type="checkbox" />
                  ) : field.type === "textarea" ? (
                    <textarea disabled={!canEdit} rows={4} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, event.target.value)} />
                  ) : (
                    <input disabled={!canEdit} type={field.type === "number" ? "number" : "text"} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, field.type === "number" ? Number(event.target.value) : event.target.value)} />
                  )}
                </label>
              ))}
              <div className="grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
                <button className="chip-dark" disabled={!canEdit} onClick={() => selected && moveBlock(selected.blocks.findIndex((block) => block.id === selectedBlock.id), -1)} type="button"><ArrowUp size={14} /> Up</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => selected && moveBlock(selected.blocks.findIndex((block) => block.id === selectedBlock.id), 1)} type="button"><ArrowDown size={14} /> Down</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => duplicateBlock(selectedBlock)} type="button"><Copy size={14} /> Duplicate</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => mutate((page) => ({ ...page, blocks: page.blocks.map((block) => block.id === selectedBlock.id ? { ...block, is_visible: !block.is_visible } : block) }))} type="button">{selectedBlock.is_visible ? <EyeOff size={14} /> : <Eye size={14} />} {selectedBlock.is_visible ? "Hide" : "Show"}</button>
                <button className="chip-dark text-red-200" disabled={!canEdit} onClick={() => deleteBlock(selectedBlock.id)} type="button"><Trash2 size={14} /> Delete</button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {preview && (
        <div className="cms-preview-overlay" role="dialog" aria-modal="true" aria-label="Draft preview">
          <div className="cms-preview-dialog">
            <header className="flex items-center justify-between border-b border-white/10 p-3"><strong className="text-white">Draft preview</strong><button className="btn-secondary" onClick={() => setPreview(null)} type="button">Close</button></header>
            <div className="overflow-auto bg-slate-950 p-4"><div className="mx-auto max-w-full" style={{ width: canvasWidth }}><CmsBlockRenderer blocks={preview.blocks} device={device} page={preview} /></div></div>
          </div>
        </div>
      )}
    </section>
  );
}
