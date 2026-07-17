import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, EyeOff, Plus, RefreshCw, Save, Send, Trash2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiClientError } from "../../../api/client";
import { useAuth } from "../../../contexts/AuthContext";
import { CmsPageRenderer } from "../../common/CmsPageRenderer";
import { cmsBlockDefinitionMap, cmsBlockDefinitions, makeLocalBlock, type CmsDevice } from "./cmsBlockLibrary";
import { cmsApi } from "./cmsApi";
import type { CmsBlock, CmsBlockType, CmsPage } from "./types";

type SaveState = "Saved" | "Unsaved" | "Saving" | "Save failed" | "Publishing" | "Published" | "Publish failed" | "Conflict detected";

function clone(page: CmsPage): CmsPage {
  return JSON.parse(JSON.stringify(page)) as CmsPage;
}

export function LivePageEditor({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const params = useParams();
  const navigate = useNavigate();
  const [pages, setPages] = useState<CmsPage[]>([]);
  const [page, setPage] = useState<CmsPage | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [device, setDevice] = useState<CmsDevice>("desktop");
  const [saveState, setSaveState] = useState<SaveState>("Saved");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<CmsPage[]>([]);
  const [future, setFuture] = useState<CmsPage[]>([]);
  const latestRef = useRef<CmsPage | null>(null);
  const pageId = params.pageId;
  const selectedBlock = page?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const components = useMemo(() => cmsBlockDefinitions.filter((block) => ["Sections", "Basic", "Forms"].includes(block.category)), []);

  const loadPages = useCallback(async () => {
    if (!token) return;
    const result = await cmsApi.pages(token);
    setPages(result.items);
    const targetId = pageId ?? result.items.find((item) => item.status === "published")?.id ?? result.items[0]?.id;
    if (targetId) {
      const detail = await cmsApi.page(token, targetId);
      setPage(detail);
      latestRef.current = detail;
      if (!pageId) navigate(`/admin/live-pages/${detail.id}`, { replace: true });
    }
  }, [navigate, pageId, token]);

  useEffect(() => {
    void loadPages().catch((err) => setError(err instanceof Error ? err.message : "Unable to load live pages"));
  }, [loadPages]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (saveState !== "Unsaved" && saveState !== "Save failed" && saveState !== "Conflict detected") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [saveState]);

  function mutate(mutator: (page: CmsPage) => CmsPage) {
    if (!canEdit) return;
    setPage((current) => {
      if (!current) return current;
      setHistory((items) => [...items.slice(-29), clone(current)]);
      setFuture([]);
      const next = mutator(clone(current));
      latestRef.current = next;
      localStorage.setItem(`auto-ai-cms-recovery:${next.id}`, JSON.stringify(next));
      return next;
    });
    setSaveState("Unsaved");
    setMessage("");
  }

  function updateBlockContent(blockId: string, key: string, value: string | number | boolean | unknown[] | null) {
    mutate((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, content: { ...block.content, [key]: value } } : block) }));
  }

  function updatePageField(key: "hero_heading" | "hero_description", value: string) {
    mutate((current) => ({ ...current, [key]: value }));
  }

  function addBlock(blockType: CmsBlockType, afterId?: string | null) {
    mutate((current) => {
      const index = afterId ? current.blocks.findIndex((block) => block.id === afterId) + 1 : current.blocks.length;
      const block = makeLocalBlock(blockType, index);
      setSelectedBlockId(block.id);
      const blocks = [...current.blocks.slice(0, index), block, ...current.blocks.slice(index)].map((item, position) => ({ ...item, position }));
      return { ...current, blocks };
    });
  }

  function duplicateBlock(block: CmsBlock) {
    mutate((current) => {
      const index = current.blocks.findIndex((item) => item.id === block.id);
      const copy = { ...clone({ ...current, blocks: [block] }).blocks[0], id: `local-${crypto.randomUUID?.() ?? Date.now()}`, position: index + 1 };
      setSelectedBlockId(copy.id);
      return { ...current, blocks: [...current.blocks.slice(0, index + 1), copy, ...current.blocks.slice(index + 1)].map((item, position) => ({ ...item, position })) };
    });
  }

  function deleteBlock(blockId: string) {
    if (!window.confirm("Delete this block from the draft?")) return;
    mutate((current) => ({ ...current, blocks: current.blocks.filter((block) => block.id !== blockId).map((block, position) => ({ ...block, position })) }));
    setSelectedBlockId(null);
  }

  function moveSelected(direction: -1 | 1) {
    if (!selectedBlockId) return;
    mutate((current) => {
      const index = current.blocks.findIndex((block) => block.id === selectedBlockId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
      return { ...current, blocks: blocks.map((block, position) => ({ ...block, position })) };
    });
  }

  function toggleVisibility(blockId: string) {
    mutate((current) => ({ ...current, blocks: current.blocks.map((block) => block.id === blockId ? { ...block, is_visible: !block.is_visible } : block) }));
  }

  async function saveDraft(): Promise<CmsPage | null> {
    const source = latestRef.current;
    if (!token || !source || !canEdit) return source;
    setSaveState("Saving");
    setError("");
    try {
      let next = await cmsApi.updatePage(token, source);
      const serverIds = new Set(source.blocks.filter((block) => !block.id.startsWith("local-")).map((block) => block.id));
      for (const serverBlock of [...next.blocks]) {
        if (!serverIds.has(serverBlock.id)) next = await cmsApi.deleteBlock(token, next, serverBlock.id);
      }
      const localMap = new Map<string, string>();
      for (const block of source.blocks) {
        if (block.id.startsWith("local-")) {
          next = await cmsApi.addBlock(token, next, block.block_type);
          const created = next.blocks[next.blocks.length - 1];
          if (created) {
            next = await cmsApi.updateBlock(token, next, created.id, { content: block.content, is_visible: block.is_visible });
            localMap.set(block.id, created.id);
          }
        } else {
          next = await cmsApi.updateBlock(token, next, block.id, { content: block.content, is_visible: block.is_visible });
        }
      }
      const desired = source.blocks.map((block) => block.id.startsWith("local-") ? localMap.get(block.id) : block.id).filter(Boolean) as string[];
      if (desired.length === next.blocks.length) next = await cmsApi.reorderBlocks(token, next, desired);
      setPage(next);
      latestRef.current = next;
      setPages((items) => items.map((item) => item.id === next.id ? next : item));
      setSaveState("Saved");
      localStorage.removeItem(`auto-ai-cms-recovery:${next.id}`);
      return next;
    } catch (err) {
      if (source) localStorage.setItem(`auto-ai-cms-recovery:${source.id}`, JSON.stringify(source));
      setSaveState(err instanceof ApiClientError && err.status === 409 ? "Conflict detected" : "Save failed");
      setError(err instanceof Error ? err.message : "Save failed");
      return null;
    }
  }

  async function publish() {
    if (!token || !canPublish || saveState === "Publishing") return;
    const saved = saveState === "Unsaved" || saveState === "Save failed" ? await saveDraft() : page;
    if (!saved) return;
    setSaveState("Publishing");
    try {
      const next = await cmsApi.publish(token, saved, "Published from Edit Live Pages");
      setPage(next);
      latestRef.current = next;
      setSaveState("Published");
      setMessage(`Published version ${next.version} at ${new Date(next.published_at ?? Date.now()).toLocaleString()}.`);
    } catch (err) {
      setSaveState("Publish failed");
      setError(err instanceof Error ? err.message : "Publish failed");
    }
  }

  function undo() {
    if (!page || !history.length) return;
    const previous = history[history.length - 1];
    setFuture((items) => [clone(page), ...items]);
    setHistory((items) => items.slice(0, -1));
    setPage(previous);
    latestRef.current = previous;
    setSaveState("Unsaved");
  }

  function redo() {
    if (!page || !future.length) return;
    const next = future[0];
    setHistory((items) => [...items, clone(page)]);
    setFuture((items) => items.slice(1));
    setPage(next);
    latestRef.current = next;
    setSaveState("Unsaved");
  }

  const canvasWidth = device === "desktop" ? "100%" : device === "tablet" ? "768px" : "390px";
  const publicPath = page ? `/${page.slug === "home" ? "" : page.slug}` : "/";

  return (
    <section className="visual-builder" aria-label="Edit live pages">
      <header className="visual-builder-toolbar">
        <div><strong className="block text-white">Edit Live Pages</strong><span className="text-slate-400">{saveState}</span></div>
        <select className="model-select-dark" value={page?.id ?? ""} onChange={(event) => navigate(`/admin/live-pages/${event.target.value}`)}>
          {pages.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <div className="visual-builder-toolbar-actions">
          {(["desktop", "tablet", "mobile"] as CmsDevice[]).map((item) => <button key={item} className={device === item ? "chip-dark chip-dark-active" : "chip-dark"} onClick={() => setDevice(item)} type="button">{item}</button>)}
          <button className="chip-dark" disabled={!history.length} onClick={undo} type="button">Undo</button>
          <button className="chip-dark" disabled={!future.length} onClick={redo} type="button">Redo</button>
          <a className="chip-dark" href={`${publicPath}?cmsFresh=${Date.now()}`} target="_blank" rel="noreferrer"><Eye size={15} /> View Published Page</a>
          {canEdit && <button className="btn-secondary" disabled={saveState === "Saving"} onClick={() => void saveDraft()} type="button"><Save size={15} /> Save Draft</button>}
          {canPublish && <button className="btn-primary" disabled={saveState === "Publishing"} onClick={() => void publish()} type="button"><Send size={15} /> Publish</button>}
        </div>
      </header>

      {error && <div className="mb-3 rounded border border-red-300/25 bg-red-500/10 px-3 py-2 text-sm text-red-100">{error}</div>}
      {message && <div className="mb-3 rounded border border-emerald-300/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">{message}</div>}

      <div className="visual-builder-layout">
        <main className="visual-builder-canvas-wrap xl:col-span-2">
          {!page ? <div className="visual-builder-empty">Select a published page.</div> : (
            <div className="visual-builder-canvas" style={{ width: canvasWidth }}>
              <CmsPageRenderer
                page={page}
                blocks={page.blocks}
                device={device}
                editMode={canEdit}
                selectedBlockId={selectedBlockId}
                onSelect={setSelectedBlockId}
                onInlineChange={updateBlockContent}
                onPageFieldChange={updatePageField}
              />
              {canEdit && <button className="btn-secondary mx-auto my-4" onClick={() => addBlock("page_section", selectedBlockId)} type="button"><Plus size={15} /> Add Section</button>}
            </div>
          )}
        </main>
        <aside className="visual-builder-panel">
          <div className="visual-panel-title"><span>Properties</span></div>
          {!selectedBlock && page && (
            <div className="space-y-3">
              <label className="cms-field"><span>Hero heading</span><input disabled={!canEdit} value={page.hero_heading} onChange={(event) => updatePageField("hero_heading", event.target.value)} /></label>
              <label className="cms-field"><span>Hero description</span><textarea disabled={!canEdit} rows={4} value={page.hero_description} onChange={(event) => updatePageField("hero_description", event.target.value)} /></label>
            </div>
          )}
          {selectedBlock && (
            <div className="space-y-3">
              <strong className="text-white">{cmsBlockDefinitionMap[selectedBlock.block_type]?.label ?? selectedBlock.block_type}</strong>
              {(cmsBlockDefinitionMap[selectedBlock.block_type]?.fields ?? []).map((field) => (
                <label className="cms-field" key={field.key}>
                  <span>{field.label}</span>
                  {field.type === "textarea" ? (
                    <textarea disabled={!canEdit} rows={4} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, event.target.value)} />
                  ) : field.type === "boolean" ? (
                    <input disabled={!canEdit} checked={Boolean(selectedBlock.content[field.key])} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, event.target.checked)} type="checkbox" />
                  ) : (
                    <input disabled={!canEdit} value={String(selectedBlock.content[field.key] ?? "")} onChange={(event) => updateBlockContent(selectedBlock.id, field.key, field.type === "number" ? Number(event.target.value) : event.target.value)} />
                  )}
                </label>
              ))}
              <div className="grid grid-cols-2 gap-2 border-t border-white/10 pt-3">
                <button className="chip-dark" disabled={!canEdit} onClick={() => moveSelected(-1)} type="button">Move Up</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => moveSelected(1)} type="button">Move Down</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => duplicateBlock(selectedBlock)} type="button"><Copy size={14} /> Duplicate</button>
                <button className="chip-dark" disabled={!canEdit} onClick={() => toggleVisibility(selectedBlock.id)} type="button">{selectedBlock.is_visible ? <EyeOff size={14} /> : <Eye size={14} />} Toggle</button>
                <button className="chip-dark text-red-200" disabled={!canEdit} onClick={() => deleteBlock(selectedBlock.id)} type="button"><Trash2 size={14} /> Delete</button>
              </div>
              <details className="border-t border-white/10 pt-3">
                <summary className="visual-layer-summary">Add block after selection</summary>
                <div className="mt-2 grid gap-2">
                  {components.map((item) => <button className="visual-component-button" key={item.type} onClick={() => addBlock(item.type, selectedBlock.id)} type="button"><Plus size={13} /> {item.label}</button>)}
                </div>
              </details>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
