import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Archive, Copy, Eye, ImagePlus, Plus, Save, Search, Send, Trash2, Upload } from "lucide-react";
import { resolveApiAssetUrl } from "../../../api/client";
import { useAuth } from "../../../contexts/AuthContext";
import { cmsApi } from "./cmsApi";
import type { CmsAnnouncement, CmsFaq, CmsMedia, CmsTextEntry } from "./types";
import type { CmsSection } from "./cmsRouting";

function pretty(value: string) {
  return value.replace(/[._-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function TextManager({ kind, canEdit, canPublish }: { kind: "global-content" | "ui-text"; canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const [entries, setEntries] = useState<CmsTextEntry[]>([]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<Record<string, "idle" | "saving" | "saved" | "failed">>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    try { setEntries(await cmsApi.textEntries(token, kind, query)); setError(""); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : "Unable to load text"); }
  }, [kind, query, token]);
  useEffect(() => { void load(); }, [load]);

  function change(id: string, value: string) {
    setEntries((current) => current.map((item) => item.id === id ? { ...item, draft_value: value } : item));
    setState((current) => ({ ...current, [id]: "idle" }));
  }

  async function save(entry: CmsTextEntry) {
    if (!token || !canEdit) return;
    setState((current) => ({ ...current, [entry.id]: "saving" }));
    try {
      const saved = await cmsApi.updateText(token, kind, entry, entry.draft_value);
      setEntries((current) => current.map((item) => item.id === saved.id ? saved : item));
      setState((current) => ({ ...current, [entry.id]: "saved" }));
    } catch (requestError) {
      setState((current) => ({ ...current, [entry.id]: "failed" }));
      setError(requestError instanceof Error ? requestError.message : "Save failed");
    }
  }

  async function action(entry: CmsTextEntry, value: "publish" | "reset") {
    if (!token) return;
    try {
      const source = value === "publish" && state[entry.id] !== "saved" ? await cmsApi.updateText(token, kind, entry, entry.draft_value) : entry;
      const saved = await cmsApi.textAction(token, kind, source, value);
      setEntries((current) => current.map((item) => item.id === saved.id ? saved : item));
      setState((current) => ({ ...current, [entry.id]: "saved" }));
      setError("");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : `${pretty(value)} failed`); }
  }

  return (
    <section>
      <div className="mb-4"><h2 className="text-lg font-semibold text-white">{kind === "ui-text" ? "UI Text" : "Global Content"}</h2><p className="text-sm text-slate-400">{kind === "ui-text" ? "Only approved, mandatory text keys are editable." : "Shared values apply wherever the public site consumes them."}</p></div>
      <label className="relative mb-4 block"><Search className="absolute left-3 top-3 text-slate-500" size={15} /><input className="text-input-dark h-10 w-full pl-9" placeholder="Search keys and defaults" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {error && <p className="mb-3 rounded border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">{error}</p>}
      <div className="space-y-2">{entries.map((entry) => (
        <article className="cms-text-row" key={entry.id}>
          <div className="min-w-0"><div className="flex flex-wrap gap-2"><strong className="text-sm text-white">{entry.key}</strong><span className="cms-status">{entry.group}</span><span className={`cms-status cms-status-${entry.status}`}>{entry.status}</span></div><p className="mt-1 text-xs text-slate-500">Default: {entry.default_value}</p></div>
          <textarea disabled={!canEdit} rows={2} value={entry.draft_value} onChange={(event) => change(entry.id, event.target.value)} />
          <div className="flex flex-wrap gap-2"><button className="btn-secondary" disabled={!canEdit || state[entry.id] === "saving"} onClick={() => void save(entry)} type="button"><Save size={14} /> {state[entry.id] === "saving" ? "Saving" : state[entry.id] === "saved" ? "Saved" : "Save draft"}</button><button className="btn-secondary" disabled={!canEdit} onClick={() => void action(entry, "reset")} type="button">Reset default</button>{canPublish && <button className="btn-primary" onClick={() => void action(entry, "publish")} type="button"><Send size={14} /> Publish</button>}</div>
        </article>
      ))}</div>
    </section>
  );
}

function FaqManager({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const [items, setItems] = useState<CmsFaq[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { if (token) try { setItems(await cmsApi.faqs(token, query)); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load FAQs"); } }, [query, token]);
  useEffect(() => { void load(); }, [load]);
  function change(id: string, patch: Partial<CmsFaq>) { setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); }
  async function create() { if (!token || !canEdit) return; try { const created = await cmsApi.createFaq(token); setItems((current) => [...current, created]); } catch (err) { setError(err instanceof Error ? err.message : "Create failed"); } }
  async function save(item: CmsFaq) { if (!token || !canEdit) return; try { const saved = await cmsApi.updateFaq(token, item); change(item.id, saved); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); } }
  async function action(item: CmsFaq, value: "publish" | "archive") { if (!token || !canPublish || !window.confirm(`${pretty(value)} this FAQ?`)) return; try { const saved = await cmsApi.faqAction(token, item, value); change(item.id, saved); } catch (err) { setError(err instanceof Error ? err.message : "Action failed"); } }
  return <section><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-lg font-semibold text-white">FAQ Manager</h2><p className="text-sm text-slate-400">Search, reorder, preview and publish selected FAQs.</p></div>{canEdit && <button className="btn-secondary" onClick={() => void create()} type="button"><Plus size={15} /> Add FAQ</button>}</div><input className="text-input-dark mb-4 h-10 w-full" placeholder="Search questions and answers" value={query} onChange={(event) => setQuery(event.target.value)} />{error && <p className="mb-3 text-sm text-red-200">{error}</p>}<div className="space-y-3">{items.map((item) => <article className="cms-collection-card" key={item.id}><div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_90px]"><label className="cms-field"><span>Question</span><input disabled={!canEdit} value={item.question} onChange={(event) => change(item.id, { question: event.target.value })} /></label><label className="cms-field"><span>Category</span><input disabled={!canEdit} value={item.category} onChange={(event) => change(item.id, { category: event.target.value })} /></label><label className="cms-field"><span>Order</span><input disabled={!canEdit} min={0} type="number" value={item.position} onChange={(event) => change(item.id, { position: Number(event.target.value) })} /></label></div><label className="cms-field mt-3"><span>Answer</span><textarea disabled={!canEdit} rows={3} value={item.answer} onChange={(event) => change(item.id, { answer: event.target.value })} /></label><div className="mt-3 flex flex-wrap items-center gap-2"><label className="cms-check"><input disabled={!canEdit} type="checkbox" checked={item.enabled} onChange={(event) => change(item.id, { enabled: event.target.checked })} /> Enabled</label><span className={`cms-status cms-status-${item.status}`}>{item.status}</span>{canEdit && <button className="btn-secondary" onClick={() => void save(item)} type="button"><Save size={14} /> Save draft</button>}{canPublish && <button className="btn-primary" onClick={() => void action(item, "publish")} type="button"><Send size={14} /> Publish</button>}{canPublish && <button className="btn-secondary" onClick={() => void action(item, "archive")} type="button"><Archive size={14} /> Archive</button>}</div></article>)}</div></section>;
}

function AnnouncementManager({ canEdit, canPublish }: { canEdit: boolean; canPublish: boolean }) {
  const { token } = useAuth();
  const [items, setItems] = useState<CmsAnnouncement[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => { if (token) try { setItems(await cmsApi.announcements(token)); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load announcements"); } }, [token]);
  useEffect(() => { void load(); }, [load]);
  function change(id: string, patch: Partial<CmsAnnouncement>) { setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); }
  async function create() { if (!token || !canEdit) return; try { const created = await cmsApi.createAnnouncement(token); setItems((current) => [created, ...current]); } catch (err) { setError(err instanceof Error ? err.message : "Create failed"); } }
  async function save(item: CmsAnnouncement) { if (!token || !canEdit) return; try { change(item.id, await cmsApi.updateAnnouncement(token, item)); } catch (err) { setError(err instanceof Error ? err.message : "Save failed"); } }
  async function action(item: CmsAnnouncement, value: "publish" | "archive") { if (!token || !canPublish || !window.confirm(`${pretty(value)} this announcement?`)) return; try { change(item.id, await cmsApi.announcementAction(token, item, value)); } catch (err) { setError(err instanceof Error ? err.message : "Action failed"); } }
  return <section><div className="mb-4 flex items-end justify-between gap-2"><div><h2 className="text-lg font-semibold text-white">Announcements</h2><p className="text-sm text-slate-400">Non-intrusive banners for website, Android or both.</p></div>{canEdit && <button className="btn-secondary" onClick={() => void create()} type="button"><Plus size={15} /> New announcement</button>}</div>{error && <p className="mb-3 text-sm text-red-200">{error}</p>}<div className="space-y-3">{items.map((item) => <article className="cms-collection-card" key={item.id}><div className="grid gap-3 md:grid-cols-2"><label className="cms-field"><span>Title</span><input disabled={!canEdit} value={item.title} onChange={(event) => change(item.id, { title: event.target.value })} /></label><label className="cms-field"><span>Action text</span><input disabled={!canEdit} value={item.action_text} onChange={(event) => change(item.id, { action_text: event.target.value })} /></label><label className="cms-field md:col-span-2"><span>Message</span><textarea disabled={!canEdit} rows={3} value={item.message} onChange={(event) => change(item.id, { message: event.target.value })} /></label><label className="cms-field"><span>Target URL</span><input disabled={!canEdit} value={item.target_url} onChange={(event) => change(item.id, { target_url: event.target.value })} /></label><label className="cms-field"><span>Target</span><select disabled={!canEdit} value={item.targets} onChange={(event) => change(item.id, { targets: event.target.value as CmsAnnouncement["targets"] })}><option value="website">Website</option><option value="android">Android</option><option value="both">Both</option></select></label><label className="cms-field"><span>Start (UTC)</span><input disabled={!canEdit} type="datetime-local" value={item.start_at?.slice(0, 16) ?? ""} onChange={(event) => change(item.id, { start_at: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label><label className="cms-field"><span>End (UTC)</span><input disabled={!canEdit} type="datetime-local" value={item.end_at?.slice(0, 16) ?? ""} onChange={(event) => change(item.id, { end_at: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label></div><div className="mt-3 flex flex-wrap items-center gap-2"><label className="cms-check"><input disabled={!canEdit} type="checkbox" checked={item.dismissible} onChange={(event) => change(item.id, { dismissible: event.target.checked })} /> Dismissible</label><span className={`cms-status cms-status-${item.status}`}>{item.status}</span>{canEdit && <button className="btn-secondary" onClick={() => void save(item)} type="button"><Save size={14} /> Save draft</button>}{canPublish && <button className="btn-primary" onClick={() => void action(item, "publish")} type="button"><Send size={14} /> Publish</button>}{canPublish && <button className="btn-secondary" onClick={() => void action(item, "archive")} type="button"><Archive size={14} /> Archive</button>}</div></article>)}</div></section>;
}

function MediaManager({ canEdit }: { canEdit: boolean }) {
  const { token } = useAuth();
  const [items, setItems] = useState<CmsMedia[]>([]);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { if (token) try { setItems((await cmsApi.media(token, query)).items); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load media"); } }, [query, token]);
  useEffect(() => { void load(); }, [load]);
  function change(id: string, patch: Partial<CmsMedia>) { setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item)); }
  async function upload() { if (!token || !file || !canEdit) return; const form = new FormData(); form.append("file", file); setBusy(true); try { const item = await cmsApi.uploadMedia(token, form); setItems((current) => [item, ...current]); setFile(null); setError(""); } catch (err) { setError(err instanceof Error ? err.message : "Upload failed"); } finally { setBusy(false); } }
  async function save(item: CmsMedia) { if (!token || !canEdit) return; try { change(item.id, await cmsApi.updateMedia(token, item)); } catch (err) { setError(err instanceof Error ? err.message : "Metadata save failed"); } }
  async function replace(item: CmsMedia, event: ChangeEvent<HTMLInputElement>) { const replacement = event.target.files?.[0]; if (!token || !replacement || !canEdit) return; const form = new FormData(); form.append("file", replacement); try { change(item.id, await cmsApi.replaceMedia(token, item.id, form)); } catch (err) { setError(err instanceof Error ? err.message : "Replace failed"); } finally { event.target.value = ""; } }
  async function remove(item: CmsMedia) { if (!token || !canEdit || !window.confirm("Delete this unused media asset?")) return; try { await cmsApi.deleteMedia(token, item.id); setItems((current) => current.filter((asset) => asset.id !== item.id)); } catch (err) { setError(err instanceof Error ? err.message : "Delete failed. Assets in use cannot be deleted."); } }
  return <section><div className="mb-4"><h2 className="text-lg font-semibold text-white">Media Library</h2><p className="text-sm text-slate-400">Validated JPG, PNG and WebP images, maximum 8 MB.</p></div><div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,auto)]"><label className="relative"><Search className="absolute left-3 top-3 text-slate-500" size={15} /><input className="text-input-dark h-10 w-full pl-9" placeholder="Search media" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{canEdit && <div className="flex gap-2"><input className="text-input-dark min-w-0" accept=".jpg,.jpeg,.png,.webp" type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><button className="btn-primary" disabled={!file || busy} onClick={() => void upload()} type="button"><Upload size={15} /> {busy ? "Uploading" : "Upload"}</button></div>}</div>{error && <p className="mb-3 text-sm text-red-200">{error}</p>}<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article className="cms-media-card" key={item.id}><img src={resolveApiAssetUrl(item.url)} alt={item.alt_text || "CMS media preview"} /><div className="p-3"><strong className="block truncate text-sm text-white">{item.filename}</strong><p className="text-xs text-slate-400">{formatBytes(item.file_size)} · Used {item.usage_count} times</p><label className="cms-field mt-2"><span>Alt text</span><input disabled={!canEdit} value={item.alt_text} onChange={(event) => change(item.id, { alt_text: event.target.value })} /></label><label className="cms-field mt-2"><span>Caption</span><input disabled={!canEdit} value={item.caption} onChange={(event) => change(item.id, { caption: event.target.value })} /></label><div className="mt-3 flex flex-wrap gap-1"><button className="icon-button-dark" title="Copy media URL" onClick={() => void navigator.clipboard.writeText(resolveApiAssetUrl(item.url))} type="button"><Copy size={15} /></button>{canEdit && <button className="icon-button-dark" title="Save metadata" onClick={() => void save(item)} type="button"><Save size={15} /></button>}{canEdit && <label className="icon-button-dark cursor-pointer" title="Replace image"><ImagePlus size={15} /><input className="sr-only" accept=".jpg,.jpeg,.png,.webp" type="file" onChange={(event) => void replace(item, event)} /></label>}{canEdit && <button className="icon-button-dark text-red-200" disabled={item.usage_count > 0} title={item.usage_count ? "Asset is in use" : "Delete image"} onClick={() => void remove(item)} type="button"><Trash2 size={15} /></button>}</div></div></article>)}</div></section>;
}

function FormsManager({ canEdit }: { canEdit: boolean }) {
  const { token } = useAuth();
  const [pages, setPages] = useState<Array<{ pageTitle: string; slug: string; forms: Array<{ id: string; title: string; status: string }> }>>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!token) return;
    try {
      const result = await cmsApi.pages(token);
      const details = await Promise.all(result.items.map((page) => cmsApi.page(token, page.id)));
      setPages(details
        .map((page) => ({
          pageTitle: page.title,
          slug: page.slug,
          forms: page.blocks
            .filter((block) => block.block_type === "form" || block.block_type.endsWith("_input") || block.block_type === "submit_button")
            .map((block) => ({
              id: block.id,
              title: String(block.content.title ?? block.content.label ?? block.content.heading ?? block.block_type),
              status: block.is_visible ? "visible" : "hidden"
            }))
        }))
        .filter((page) => page.forms.length > 0));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load form blocks");
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">Forms</h2>
          <p className="text-sm text-slate-400">Form blocks are stored in the shared CMS page draft and edited through the page or live editor.</p>
        </div>
        <button className="btn-secondary" onClick={() => void load()} type="button"><Eye size={15} /> Refresh</button>
      </div>
      {error && <p className="mb-3 text-sm text-red-200">{error}</p>}
      <div className="space-y-3">
        {pages.map((page) => (
          <article className="cms-collection-card" key={page.slug}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div><strong className="text-white">{page.pageTitle}</strong><p className="text-xs text-slate-400">/{page.slug === "home" ? "" : page.slug}</p></div>
              {canEdit && <span className="cms-status">Edit on page</span>}
            </div>
            <div className="grid gap-2">
              {page.forms.map((form) => <div className="cms-page-row" key={form.id}><span>{form.title}</span><span className="cms-status">{form.status}</span></div>)}
            </div>
          </article>
        ))}
        {!pages.length && <div className="cms-collection-card text-sm text-slate-300">No form blocks exist yet. Add a Form block from Website Builder or Edit Live Pages.</div>}
      </div>
    </section>
  );
}

export function CmsCollectionManager({ section, canEdit, canPublish }: { section: CmsSection; canEdit: boolean; canPublish: boolean }) {
  if (section === "global") return <TextManager kind="global-content" canEdit={canEdit} canPublish={canPublish} />;
  if (section === "ui") return <TextManager kind="ui-text" canEdit={canEdit} canPublish={canPublish} />;
  if (section === "faqs") return <FaqManager canEdit={canEdit} canPublish={canPublish} />;
  if (section === "announcements") return <AnnouncementManager canEdit={canEdit} canPublish={canPublish} />;
  if (section === "forms") return <FormsManager canEdit={canEdit} />;
  return <MediaManager canEdit={canEdit} />;
}
