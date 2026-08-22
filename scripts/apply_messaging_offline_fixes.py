from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    if content.count(old) != 1:
        raise RuntimeError(f"Expected one match in {path}, found {content.count(old)}")
    write(path, content.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    content = read(path)
    if addition.strip() in content:
        return
    if marker not in content:
        raise RuntimeError(f"Marker not found in {path}: {marker}")
    write(path, content + "\n" + addition.strip() + "\n")


def patch_library() -> None:
    write("frontend/src/components/chat/LibraryModal.tsx", r'''import { useEffect, useState } from "react";
import { Eye, FileCode2, FileText, Grid2X2, Image as ImageIcon, List, LoaderCircle, Pencil, Search, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { LibraryAsset, LibraryAttachment } from "../../types";
import "./library.css";

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isPreviewable(asset: LibraryAsset) {
  return asset.file_type === "image" || asset.mime_type === "application/pdf";
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
  if (asset.mime_type === "application/pdf") return <FileText />;
  if (asset.file_type === "code") return <FileCode2 />;
  return <FileText />;
}

export function LibraryModal({ open, token, chatId, onClose, onAttach }: {
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
  const [error, setError] = useState("");
  const [previewAsset, setPreviewAsset] = useState<LibraryAsset | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      api.listLibraryAssets(token, { query, fileType: fileType || undefined })
        .then((page) => { if (!controller.signal.aborted) setAssets(page.items); })
        .catch((loadError) => {
          if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : "Library could not be loaded.");
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 220 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [fileType, open, query, token]);

  useEffect(() => {
    if (!previewAsset) { setPreviewUrl(""); return; }
    let active = true;
    let objectUrl = "";
    setPreviewUrl("");
    api.previewLibraryAsset(token, previewAsset.id).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreviewUrl(objectUrl);
    }).catch(() => { if (active) setError("Preview could not be loaded."); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [previewAsset, token]);

  useEffect(() => {
    if (!open) return;
    const onBack = (event: Event) => {
      event.preventDefault();
      if (previewAsset) setPreviewAsset(null); else onClose();
    };
    window.addEventListener("auto-ai-android-back", onBack);
    return () => window.removeEventListener("auto-ai-android-back", onBack);
  }, [onClose, open, previewAsset]);

  async function attach() {
    if (!selected.size) return;
    setLoading(true);
    setError("");
    try {
      const attached: LibraryAttachment[] = [];
      for (const id of selected) attached.push(await api.attachLibraryAsset(token, id, chatId));
      onAttach(attached);
      onClose();
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : "Attachment processing failed.");
    } finally { setLoading(false); }
  }

  async function rename(asset: LibraryAsset) {
    const value = window.prompt("Rename library item", asset.display_name)?.trim();
    if (!value || value === asset.display_name) return;
    try {
      const updated = await api.renameLibraryAsset(token, asset.id, value);
      setAssets((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (previewAsset?.id === updated.id) setPreviewAsset(updated);
    } catch (renameError) { setError(renameError instanceof Error ? renameError.message : "Rename failed."); }
  }

  async function remove(asset: LibraryAsset) {
    if (!window.confirm(`Delete “${asset.display_name}” from your library?`)) return;
    try {
      await api.deleteLibraryAsset(token, asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setSelected((current) => { const next = new Set(current); next.delete(asset.id); return next; });
      if (previewAsset?.id === asset.id) setPreviewAsset(null);
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Delete failed."); }
  }

  if (!open) return null;
  return (
    <div className="library-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`library-modal ${previewAsset ? "library-modal-previewing" : ""}`} role="dialog" aria-modal="true" aria-label="AI Chat attachment library">
        <header>
          <span><strong>Library</strong><small>Saved AI Chat attachments</small></span>
          <button type="button" onClick={onClose} aria-label="Close library"><X size={18} /></button>
        </header>
        {!previewAsset ? <>
          <div className="library-toolbar">
            <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search attachments" /></label>
            <button type="button" onClick={() => setView((current) => current === "grid" ? "list" : "grid")} aria-label="Toggle grid or list view">{view === "grid" ? <List size={16} /> : <Grid2X2 size={16} />}</button>
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
                  const next = new Set(current); if (next.has(asset.id)) next.delete(asset.id); else next.add(asset.id); return next;
                })}>
                  <span className="library-preview"><AssetPreview asset={asset} token={token} /></span>
                  <span><strong title={asset.display_name}>{asset.display_name}</strong><small>{formatSize(asset.file_size)} · {new Date(asset.created_at).toLocaleDateString()}</small></span>
                </button>
                <div className="library-card-actions">
                  {isPreviewable(asset) && <button type="button" onClick={() => setPreviewAsset(asset)} aria-label={`Preview ${asset.display_name}`} title="Preview"><Eye size={14} /></button>}
                  <button type="button" onClick={() => void rename(asset)} aria-label={`Rename ${asset.display_name}`}><Pencil size={14} /></button>
                  <button type="button" onClick={() => void remove(asset)} aria-label={`Delete ${asset.display_name}`}><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
            {!loading && !assets.length && <p className="library-empty">Your saved photos, PDFs, documents and code files will appear here.</p>}
            {loading && <p className="library-empty"><LoaderCircle className="animate-spin" /> Loading…</p>}
          </div>
          <footer><span>{selected.size} selected</span><button type="button" className="btn-primary" disabled={!selected.size || loading} onClick={() => void attach()}>Attach</button></footer>
        </> : <>
          <div className="library-preview-head"><button type="button" onClick={() => setPreviewAsset(null)}><ArrowLeftIcon /></button><strong title={previewAsset.display_name}>{previewAsset.display_name}</strong></div>
          <div className="library-preview-stage">
            {!previewUrl && <LoaderCircle className="animate-spin" />}
            {previewUrl && previewAsset.file_type === "image" && <img src={previewUrl} alt={previewAsset.display_name} />}
            {previewUrl && previewAsset.mime_type === "application/pdf" && <iframe title={previewAsset.display_name} src={previewUrl} />}
          </div>
          {previewUrl && previewAsset.mime_type === "application/pdf" && <a className="library-open-preview" href={previewUrl} target="_blank" rel="noreferrer">Open PDF in viewer</a>}
        </>}
      </section>
    </div>
  );
}

function ArrowLeftIcon() { return <span aria-hidden="true">←</span>; }
''')


def patch_library_css() -> None:
    append_once("frontend/src/components/chat/library.css", "", r'''
/* Compact attachment library + in-app preview */
.library-modal { width: min(720px, calc(100vw - 24px)); max-height: min(680px, calc(100dvh - 32px)); }
.library-assets { max-height: min(450px, 55dvh); overflow: auto; }
.library-card-actions { display: flex; gap: 3px; }
.library-card-actions button { display: grid; place-items: center; width: 28px; height: 28px; }
.library-modal-previewing { width: min(900px, calc(100vw - 20px)); }
.library-preview-head { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 0; }
.library-preview-head button { width: 34px; height: 34px; border-radius: 9px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: inherit; }
.library-preview-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.library-preview-stage { min-height: min(520px, 65dvh); display: grid; place-items: center; overflow: hidden; border: 1px solid rgba(255,255,255,.1); border-radius: 12px; background: rgba(0,0,0,.22); }
.library-preview-stage img { max-width: 100%; max-height: 64dvh; object-fit: contain; }
.library-preview-stage iframe { width: 100%; height: min(600px, 65dvh); border: 0; background: #fff; }
.library-open-preview { display: inline-flex; justify-content: center; margin-top: 8px; color: #8bd8ff; font-size: 12px; text-decoration: none; }
@media (max-width: 767px) {
  .library-modal { width: calc(100vw - 12px); max-height: calc(100dvh - 18px); }
  .library-assets { max-height: 52dvh; }
  .library-modal-previewing { width: calc(100vw - 10px); }
  .library-preview-stage { min-height: 58dvh; }
}
''')


def patch_workspace_navigation() -> None:
    path = "frontend/src/components/layout/WorkspaceNavigation.tsx"
    content = read(path)
    old = '''  const mobileItems = user?.role === "seva_agent" ? [agentOperationsItem] : isAdmin
    ? [primaryItems[0], primaryItems[2], sevaOperationsItem, primaryItems[4], primaryItems[5]]
    : primaryItems.slice(0, 5);'''
    new = '''  const mobileItems = user?.role === "seva_agent" ? [agentOperationsItem] : isAdmin
    ? [primaryItems[0], primaryItems[5], sevaOperationsItem, primaryItems[4], primaryItems[9]]
    : [primaryItems[0], primaryItems[1], primaryItems[5], primaryItems[4], primaryItems[2]];'''
    if old not in content:
        raise RuntimeError("mobileItems block not found")
    write(path, content.replace(old, new, 1))


def patch_offline_cache() -> None:
    write("frontend/src/features/userMessages/offlineMessageCache.ts", r'''import type { ChatPublicUser, UserMessage, UserThread } from "./types";

const PREFIX = "autoai:messages-cache:v2:";
const MAX_THREADS = 60;
const MAX_MESSAGES = 250;

type CacheShape = { threads: UserThread[]; messages: Record<string, UserMessage[]>; peers: ChatPublicUser[]; savedAt: string };

function key(userId: string) { return `${PREFIX}${userId}`; }

function read(userId: string): CacheShape {
  try {
    const raw = window.localStorage.getItem(key(userId));
    if (!raw) return { threads: [], messages: {}, peers: [], savedAt: "" };
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    return {
      threads: Array.isArray(parsed.threads) ? parsed.threads : [],
      messages: parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {},
      peers: Array.isArray(parsed.peers) ? parsed.peers : [],
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch { return { threads: [], messages: {}, peers: [], savedAt: "" }; }
}

function write(userId: string, value: CacheShape) {
  try { window.localStorage.setItem(key(userId), JSON.stringify(value)); } catch { /* quota/private-mode: best effort */ }
}

export function cacheThreads(userId: string, threads: UserThread[]) {
  const current = read(userId);
  const merged = [...threads, ...current.threads.filter((old) => !threads.some((item) => item.id === old.id))]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, MAX_THREADS);
  const peers = [...merged.map((item) => item.peer), ...current.peers]
    .filter((peer, index, all) => all.findIndex((item) => item.id === peer.id) === index)
    .slice(0, MAX_THREADS);
  write(userId, { ...current, threads: merged, peers, savedAt: new Date().toISOString() });
}

export function cacheMessages(userId: string, threadId: string, messages: UserMessage[]) {
  const current = read(userId);
  const next = { ...current.messages, [threadId]: messages.slice(-MAX_MESSAGES) };
  write(userId, { ...current, messages: next, savedAt: new Date().toISOString() });
}

export function readCachedThreads(userId: string, archived?: boolean) {
  const items = read(userId).threads;
  return archived === undefined ? items : items.filter((item) => item.archived === archived);
}

export function readCachedMessages(userId: string, threadId: string) { return read(userId).messages[threadId] || []; }
export function readCachedPeers(userId: string) { return read(userId).peers; }
export function hasCachedMessages(userId: string) { const value = read(userId); return value.threads.length > 0 || Object.keys(value.messages).length > 0; }
''')


def patch_user_messages() -> None:
    path = "frontend/src/features/userMessages/UserMessagesPage.tsx"
    content = read(path)
    content = content.replace(
        'import { AppNotice } from "../../components/common/AppNotice";\n',
        'import { AppNotice } from "../../components/common/AppNotice";\nimport { cacheMessages, cacheThreads, readCachedMessages, readCachedPeers, readCachedThreads } from "./offlineMessageCache";\n', 1)
    content = content.replace(
        '  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected">("disconnected");\n',
        '  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected">("disconnected");\n  const [offline, setOffline] = useState(() => !navigator.onLine);\n', 1)
    old_load = '''  const loadThreads = useCallback(async () => {
    if (!token) return;
    const archived = filter === "archived" ? true : filter === "all" || filter === "unread" || filter === "favourites" ? false : undefined;
    const page = await userMessagesApi.listThreads(token, archived);
    setThreads(page.items);
  }, [filter, token]);'''
    new_load = '''  const loadThreads = useCallback(async () => {
    if (!token) return;
    const archived = filter === "archived" ? true : filter === "all" || filter === "unread" || filter === "favourites" ? false : undefined;
    try {
      const page = await userMessagesApi.listThreads(token, archived);
      setThreads(page.items);
      if (user?.id) cacheThreads(user.id, page.items);
      setOffline(false);
    } catch (loadError) {
      if (user?.id) {
        const cached = readCachedThreads(user.id, archived);
        if (cached.length) {
          setThreads(cached);
          setOffline(true);
          return;
        }
      }
      setOffline(!navigator.onLine);
      throw loadError;
    }
  }, [filter, token, user?.id]);'''
    if old_load not in content: raise RuntimeError("loadThreads block not found")
    content = content.replace(old_load, new_load, 1)
    old_try = '''      setActiveThread(thread);
      upsertThread(thread);
      setMessages(messagePage.items);
      markDeliveredOnce(id);
      markReadOnce(id);'''
    new_try = '''      setActiveThread(thread);
      upsertThread(thread);
      setMessages(messagePage.items);
      if (user?.id) {
        cacheThreads(user.id, [thread]);
        cacheMessages(user.id, id, messagePage.items);
      }
      setOffline(false);
      markDeliveredOnce(id);
      markReadOnce(id);'''
    if old_try not in content: raise RuntimeError("thread success block not found")
    content = content.replace(old_try, new_try, 1)
    old_catch = '''    } catch (loadError) {
      if (controller.signal.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "Unable to open chat.");
      setActiveThread(null);
      setMessages([]);
      navigate("/messages", { replace: true });
    } finally {'''
    new_catch = '''    } catch (loadError) {
      if (controller.signal.aborted) return;
      const cachedThread = user?.id ? readCachedThreads(user.id).find((item) => item.id === id) : undefined;
      const cachedMessages = user?.id ? readCachedMessages(user.id, id) : [];
      if (cachedThread && cachedMessages.length) {
        setActiveThread(cachedThread);
        upsertThread(cachedThread);
        setMessages(cachedMessages);
        setOffline(true);
        setError("Offline mode: showing saved messages. Sending and realtime updates will resume when internet returns.");
      } else {
        setError(loadError instanceof Error ? loadError.message : "Unable to open chat.");
        setActiveThread(null);
        setMessages([]);
        navigate("/messages", { replace: true });
      }
    } finally {'''
    if old_catch not in content: raise RuntimeError("thread catch block not found")
    content = content.replace(old_catch, new_catch, 1)
    old_effect = '''  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);'''
    new_effect = '''  useEffect(() => {
    messagesRef.current = messages;
    if (user?.id && threadId && messages.length) cacheMessages(user.id, threadId, messages);
  }, [messages, threadId, user?.id]);

  useEffect(() => {
    threadsRef.current = threads;
    if (user?.id && threads.length) cacheThreads(user.id, threads);
  }, [threads, user?.id]);

  useEffect(() => {
    const goOnline = () => { setOffline(false); void retryPendingTextMessages(); void loadThreads(); };
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => { window.removeEventListener("online", goOnline); window.removeEventListener("offline", goOffline); };
  }, [loadThreads]);

  useEffect(() => {
    if (!user?.id) return;
    const cached = readCachedThreads(user.id);
    if (!threads.length && cached.length && !navigator.onLine) setThreads(cached);
    if (threadId && !messages.length && !navigator.onLine) {
      const cachedMessages = readCachedMessages(user.id, threadId);
      const cachedThread = cached.find((item) => item.id === threadId);
      if (cachedMessages.length && cachedThread) { setActiveThread(cachedThread); setMessages(cachedMessages); setOffline(true); }
    }
  }, [user?.id, threadId]);'''
    if old_effect not in content: raise RuntimeError("message/thread effect block not found")
    content = content.replace(old_effect, new_effect, 1)
    old_header = '<header className="um-list-head">\n          <span><MessageCircle size={20} /><strong>Messages</strong><small>{socketState === "connected" ? "Realtime" : "Connecting"}</small></span>'
    new_header = '<header className="um-list-head">\n          <span><MessageCircle size={20} /><strong>Messages</strong><small>{offline ? "Offline · Saved messages" : socketState === "connected" ? "Realtime" : "Connecting"}</small></span>'
    if old_header not in content: raise RuntimeError("messages header not found")
    content = content.replace(old_header, new_header, 1)
    old_search = '''      void userMessagesApi.searchUsers(token, term, 1, controller.signal).then((page) => {
        if (controller.signal.aborted) return;
        setSearchResults(page.items);'''
    new_search = '''      void userMessagesApi.searchUsers(token, term, 1, controller.signal).then((page) => {
        if (controller.signal.aborted) return;
        setSearchResults(page.items);'''
    # Keep online search behavior; offline fallback is inserted in catch.
    old_search_catch = '''        if (!controller.signal.aborted) {
          setSearchResults([]);
          setSearchState("ERROR");
          setError(searchError instanceof Error ? `Search could not be completed: ${searchError.message}` : "Search could not be completed.");
        }'''
    new_search_catch = '''        if (!controller.signal.aborted) {
          const cachedPeers = user?.id ? readCachedPeers(user.id) : [];
          const normalized = term.toLowerCase();
          const localResults = cachedPeers.filter((peer) => `${peer.display_name} ${peer.username}`.toLowerCase().includes(normalized));
          setSearchResults(localResults);
          setSearchState(localResults.length ? "RESULTS" : "EMPTY");
          setOffline(true);
          if (!localResults.length) setError(searchError instanceof Error ? `Offline: ${searchError.message}` : "Offline search has no saved user.");
        }'''
    if old_search_catch not in content: raise RuntimeError("search catch block not found")
    content = content.replace(old_search_catch, new_search_catch, 1)
    write(path, content)


def patch_android_push() -> None:
    path = "android/app/src/main/java/com/autoai/app/AutoAiSecureStoragePlugin.java"
    content = read(path)
    old = '''            writeStoredValue(getContext(), key, value);
            call.resolve();'''
    new = '''            writeStoredValue(getContext(), key, value);
            if ("auto-ai-access-token".equals(key)) {
                // Login can finish after MainActivity's startup registration. Re-register
                // immediately so the device becomes eligible for chat/update pushes.
                PushTokenRegistrar.registerStoredUserDeviceIfAuthenticated(getContext());
            }
            call.resolve();'''
    if old not in content: raise RuntimeError("secure storage setter not found")
    content = content.replace(old, new, 1)
    write(path, content)


def patch_android_permission_and_retry() -> None:
    path = "android/app/src/main/java/com/autoai/app/MainActivity.java"
    content = read(path)
    marker = '        runActivityStartupStep("firebase messaging registration", this::registerFirebaseMessagingToken);'
    if marker not in content: raise RuntimeError("Firebase registration startup marker not found")
    if 'requestNotificationPermissionIfNeeded' not in content:
        content = content.replace(marker, marker + '\n        runActivityStartupStep("notification permission", this::requestNotificationPermissionIfNeeded);', 1)
        method = r'''
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            PushTokenRegistrar.registerStoredUserDeviceIfAuthenticated(this);
            return;
        }
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4201);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 4201) PushTokenRegistrar.registerStoredUserDeviceIfAuthenticated(this);
    }
'''
        content = content.replace('    private void configureBridgeWebView() {', method + '\n    private void configureBridgeWebView() {', 1)
    # Re-register on every resume; this covers token rotation and login completion.
    resume_marker = '        runActivityStartupStep("push device sync", this::syncPushDeviceIfAuthenticated);'
    if resume_marker in content and 'runActivityStartupStep("push registration refresh"' not in content:
        content = content.replace(resume_marker, resume_marker + '\n        runActivityStartupStep("push registration refresh", () -> PushTokenRegistrar.registerStoredUserDeviceIfAuthenticated(this));', 1)
    write(path, content)


def main() -> None:
    patch_library()
    patch_library_css()
    patch_workspace_navigation()
    patch_offline_cache()
    patch_user_messages()
    patch_android_push()
    patch_android_permission_and_retry()
    print("Applied messaging, notification, library preview, mobile navigation and offline-cache fixes.")


if __name__ == "__main__":
    main()
'''}