import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import { api, type BackupPreview, type ChatBackup, type UserUsage } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useChat } from "../../contexts/ChatContext";


function message(error: unknown) {
  return error instanceof Error ? error.message : "The request could not be completed.";
}


export function AiUsagePanel() {
  const { token } = useAuth();
  const [days, setDays] = useState<1 | 7 | 30 | "custom">(7);
  const today = new Date().toISOString().slice(0, 10);
  const [rangeDraft, setRangeDraft] = useState({ start: today, end: today });
  const [customRange, setCustomRange] = useState<{ start: string; end: string } | null>(null);
  const [usage, setUsage] = useState<UserUsage | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    let active = true;
    setState("loading");
    setError("");
    if (days === "custom" && !customRange) { setState("ready"); setUsage(null); return; }
    void api.userUsage(token, days === "custom" ? 366 : days, days === "custom" ? customRange ?? undefined : undefined).then((value) => {
      if (active) { setUsage(value); setState("ready"); }
    }).catch((reason) => {
      if (active) { setError(message(reason)); setState("error"); }
    });
    return () => { active = false; };
  }, [customRange, days, token]);

  return (
    <section className="settings-card overflow-hidden" aria-labelledby="ai-usage-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-3">
        <div><h2 id="ai-usage-title" className="text-sm font-semibold">AI Usage</h2><p className="text-xs text-slate-400">Real requests recorded for this account.</p></div>
        <div className="flex gap-1" role="group" aria-label="Usage date range">
          {([1, 7, 30] as const).map((value) => <button key={value} className={days === value ? "btn-primary min-h-11 px-3 text-xs" : "btn-secondary min-h-11 px-3 text-xs"} onClick={() => setDays(value)} type="button">{value === 1 ? "Today" : `${value} days`}</button>)}
          <button className={days === "custom" ? "btn-primary min-h-11 px-3 text-xs" : "btn-secondary min-h-11 px-3 text-xs"} onClick={() => setDays("custom")} type="button">Custom</button>
        </div>
      </div>
      {days === "custom" && <form className="flex flex-wrap items-end gap-2 border-b border-white/10 p-3" onSubmit={(event) => { event.preventDefault(); if (rangeDraft.start <= rangeDraft.end) { setError(""); setCustomRange(rangeDraft); } else { setError("Start date must be on or before end date."); setState("error"); } }}>
        <label className="grid gap-1 text-xs text-slate-300">Start<input className="input-dark min-h-11" max={today} required type="date" value={rangeDraft.start} onChange={(event) => setRangeDraft((current) => ({ ...current, start: event.target.value }))} /></label>
        <label className="grid gap-1 text-xs text-slate-300">End<input className="input-dark min-h-11" max={today} required type="date" value={rangeDraft.end} onChange={(event) => setRangeDraft((current) => ({ ...current, end: event.target.value }))} /></label>
        <button className="btn-secondary min-h-11 px-3 text-xs" type="submit">Apply range</button>
      </form>}
      {state === "loading" && <p className="px-3 py-5 text-sm text-slate-300" role="status">Loading usage…</p>}
      {state === "error" && <p className="px-3 py-5 text-sm text-red-200" role="alert">{error}</p>}
      {state === "ready" && usage && usage.requests === 0 && <p className="px-3 py-5 text-sm text-slate-300">No AI usage was recorded in this range.</p>}
      {state === "ready" && usage && usage.requests > 0 && <>
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
          <article className="rounded-lg border border-white/10 p-3"><small className="text-slate-400">Requests</small><strong className="block text-lg">{usage.requests.toLocaleString()}</strong></article>
          <article className="rounded-lg border border-white/10 p-3"><small className="text-slate-400">Total tokens</small><strong className="block text-lg">{usage.total_tokens.toLocaleString()}</strong></article>
          <article className="rounded-lg border border-white/10 p-3"><small className="text-slate-400">Average latency</small><strong className="block text-lg">{usage.average_latency_ms.toLocaleString()} ms</strong></article>
          <article className="rounded-lg border border-white/10 p-3"><small className="text-slate-400">Cache</small><strong className="block text-lg">{usage.cache_hits} hit / {usage.cache_misses} miss</strong></article>
        </div>
        <div className="max-w-full overflow-x-auto" tabIndex={0} aria-label="AI usage numeric summary">
          <table className="w-full min-w-[640px] text-left text-xs"><thead className="border-y border-white/10 text-slate-400"><tr><th className="p-3">Provider / model</th><th>Requests</th><th>Input</th><th>Output</th><th>Latency</th><th>Errors</th></tr></thead><tbody>{usage.dimensions.map((item) => <tr className="border-b border-white/5" key={`${item.provider}:${item.model}`}><td className="p-3"><strong className="block text-white">{item.provider}</strong><span className="text-slate-400">{item.model}</span></td><td>{item.requests}</td><td>{item.input_tokens.toLocaleString()}</td><td>{item.output_tokens.toLocaleString()}</td><td>{item.average_latency_ms} ms</td><td>{item.errors}</td></tr>)}</tbody></table>
        </div>
      </>}
    </section>
  );
}


export function ChatBackupPanel() {
  const { token } = useAuth();
  const { refreshChats, setActiveChat } = useChat();
  const inputRef = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<ChatBackup | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function exportBackup() {
    if (!token) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const blob = await api.exportChatBackup(token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `autoai-chat-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Backup downloaded.");
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  async function chooseFile(file: File | undefined) {
    setBackup(null); setPreview(null); setError(""); setNotice("");
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { setError("Backup files must be 50 MB or smaller."); return; }
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as ChatBackup;
      if (!token) return;
      const result = await api.previewChatRestore(token, parsed);
      setBackup(parsed); setPreview(result);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  async function restore() {
    if (!token || !backup || !preview) return;
    const confirmed = mode === "replace" ? window.confirm(`Replace all current chats with ${preview.chat_count} chats from this backup? This cannot be undone.`) : true;
    if (!confirmed) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.restoreChatBackup(token, backup, mode, confirmed);
      setActiveChat(null);
      await refreshChats();
      setNotice(`Restore complete: ${result.chats_imported} chats and ${result.messages_imported} messages imported.`);
      setBackup(null); setPreview(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  return (
    <section className="settings-card overflow-hidden" aria-labelledby="chat-backup-title">
      <div className="border-b border-white/10 px-3 py-3"><h2 id="chat-backup-title" className="text-sm font-semibold">Data & Backup</h2><p className="text-xs text-slate-400">Versioned JSON export and transactional restore for your chats only.</p></div>
      <div className="grid gap-3 p-3">
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary min-h-11 px-3 text-xs" disabled={busy} onClick={() => void exportBackup()} type="button"><Download size={15} /> Export chats</button>
          <button className="btn-secondary min-h-11 px-3 text-xs" disabled={busy} onClick={() => inputRef.current?.click()} type="button"><Upload size={15} /> Choose backup</button>
          <input ref={inputRef} className="sr-only" accept="application/json,.json" type="file" onChange={(event) => void chooseFile(event.target.files?.[0])} />
        </div>
        {busy && <p className="text-sm text-slate-300" role="status"><RefreshCw className="mr-2 inline animate-spin" size={14} />Working…</p>}
        {error && <p className="text-sm text-red-200" role="alert">{error}</p>}
        {notice && <p className="text-sm text-emerald-200" role="status">{notice}</p>}
        {preview && <div className="rounded-lg border border-cyan-300/20 bg-cyan-300/5 p-3 text-xs">
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4"><div><dt className="text-slate-400">Backup date</dt><dd>{new Date(preview.backup_date).toLocaleString()}</dd></div><div><dt className="text-slate-400">Schema</dt><dd>v{preview.schema_version}</dd></div><div><dt className="text-slate-400">Chats</dt><dd>{preview.chat_count}</dd></div><div><dt className="text-slate-400">Messages</dt><dd>{preview.message_count}</dd></div></dl>
          <fieldset className="mt-3 flex flex-wrap gap-4"><legend className="sr-only">Restore mode</legend><label className="flex min-h-11 items-center gap-2"><input checked={mode === "merge"} name="restore-mode" onChange={() => setMode("merge")} type="radio" /> Merge</label><label className="flex min-h-11 items-center gap-2"><input checked={mode === "replace"} name="restore-mode" onChange={() => setMode("replace")} type="radio" /> Replace all chats</label></fieldset>
          <button className={mode === "replace" ? "btn-secondary mt-2 min-h-11 px-3 text-xs text-red-200" : "btn-primary mt-2 min-h-11 px-3 text-xs"} disabled={busy} onClick={() => void restore()} type="button">Restore backup</button>
        </div>}
      </div>
    </section>
  );
}
