import { useEffect, useRef, useState } from "react";
import { FileCode2, FileText, Grid2X2, Image as ImageIcon, List, LoaderCircle, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { api } from "../../api/client";
import type { LibraryAsset, LibraryAttachment } from "../../types";
import "./library.css";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AssetPreview({ asset, token }: { asset: LibraryAsset; token: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (asset.file_type !== "image") return;
    let active = true;
    let objectUrl = "";
    api.previewLibraryAsset(token, asset.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    }).catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.file_type, asset.id, token]);
  if (src) return <img src={src} alt="" loading="lazy" />;
  if (asset.file_type === "image") return <ImageIcon />;
  if (asset.file_type === "code") return <FileCode2 />;
  return <FileText />;
}

export function LibraryModal({
  open,
  token,
  chatId,
  onClose,
  onAttach
}: {
  open: boolean;
  token: string;
  chatId?: string;
  onClose: () => void;
  onAttach: (attachments: LibraryAttachment[]) => void;
}) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [fileType, setFileType] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api.listLibraryAssets(token, { query, fileType: fileType || undefined })
        .then((page) => {
          if (!controller.signal.aborted) setAssets(page.items);
        })
        .catch((loadError) => {
          if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Library could not be loaded.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, query ? 220 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [fileType, open, query, token]);

  useEffect(() => {
    if (!open) return;
    const onBack = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    window.addEventListener("auto-ai-android-back", onBack);
    return () => window.removeEventListener("auto-ai-android-back", onBack);
  }, [onClose, open]);

  async function upload(files: File[], source: LibraryAsset["source"]) {
    if (!files.length || uploading) return;
    setUploading(true);
    setError("");
    try {
      const uploaded: LibraryAsset[] = [];
      for (const file of files) uploaded.push(await api.uploadLibraryAsset(token, file, source));
      setAssets((current) => [...uploaded, ...current.filter((item) => !uploaded.some((next) => next.id === item.id))]);
      setSelected(new Set(uploaded.map((item) => item.id)));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function attach() {
    if (!selected.size) return;
    setLoading(true);
    setError("");
    try {
      const attached = [];
      for (const id of selected) attached.push(await api.attachLibraryAsset(token, id, chatId));
      onAttach(attached);
      onClose();
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Attachment processing failed.");
    } finally {
      setLoading(false);
    }
  }

  async function rename(asset: LibraryAsset) {
    const value = window.prompt("Rename library item", asset.display_name)?.trim();
    if (!value || value === asset.display_name) return;
    try {
      const updated = await api.renameLibraryAsset(token, asset.id, value);
      setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "Rename failed.");
    }
  }

  async function remove(asset: LibraryAsset) {
    if (!window.confirm(`Delete “${asset.display_name}” from your library?`)) return;
    try {
      await api.deleteLibraryAsset(token, asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setSelected((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Delete failed.");
    }
  }

  if (!open) return null;
  return (
    <div className="library-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="library-modal" role="dialog" aria-modal="true" aria-label="Personal upload library">
        <header>
          <span><strong>Library</strong><small>Your reusable uploads</small></span>
          <button type="button" onClick={onClose} aria-label="Close library"><X size={18} /></button>
        </header>
        <div className="library-toolbar">
          <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" /></label>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}><Upload size={15} />Upload</button>
          <button type="button" onClick={() => cameraRef.current?.click()} disabled={uploading}><ImageIcon size={15} />Photo</button>
          <button type="button" onClick={() => setView((current) => current === "grid" ? "list" : "grid")} aria-label="Toggle grid or list view">{view === "grid" ? <List size={16} /> : <Grid2X2 size={16} />}</button>
          <input ref={inputRef} hidden multiple type="file" accept="image/*,.pdf,.docx,.txt,.py,.ts,.tsx,.js,.jsx,.java,.kt,.go,.rs,.css,.html,.json,.md,.yaml,.yml,.sql" onChange={(event) => { void upload(Array.from(event.target.files || []), "upload"); event.target.value = ""; }} />
          <input ref={cameraRef} hidden type="file" accept="image/*" capture="environment" onChange={(event) => { void upload(Array.from(event.target.files || []), "camera"); event.target.value = ""; }} />
        </div>
        <div className="library-filters">
          {[["", "All"], ["image", "Images"], ["document", "Documents"], ["code", "Code"]].map(([value, label]) =>
            <button type="button" key={label} className={fileType === value ? "active" : ""} onClick={() => setFileType(value)}>{label}</button>
          )}
        </div>
        {error && <div className="library-error">{error}</div>}
        <div className={`library-assets library-assets-${view}`}>
          {assets.map((asset) => (
            <article key={asset.id} className={selected.has(asset.id) ? "selected" : ""}>
              <button type="button" className="library-card-main" onClick={() => setSelected((current) => {
                const next = new Set(current);
                if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id);
                return next;
              })}>
                <span className="library-preview"><AssetPreview asset={asset} token={token} /></span>
                <span><strong title={asset.display_name}>{asset.display_name}</strong><small>{formatSize(asset.file_size)} · {new Date(asset.created_at).toLocaleDateString()}</small></span>
              </button>
              <div className="library-card-actions">
                <button type="button" onClick={() => void rename(asset)} aria-label={`Rename ${asset.display_name}`}><Pencil size={14} /></button>
                <button type="button" onClick={() => void remove(asset)} aria-label={`Delete ${asset.display_name}`}><Trash2 size={14} /></button>
              </div>
            </article>
          ))}
          {!loading && !assets.length && <p className="library-empty">No library items found.</p>}
          {loading && <p className="library-empty"><LoaderCircle className="animate-spin" /> Loading library…</p>}
        </div>
        <footer><span>{selected.size} selected</span><button type="button" className="btn-primary" disabled={!selected.size || loading} onClick={() => void attach()}>Attach to chat</button></footer>
      </section>
    </div>
  );
}
