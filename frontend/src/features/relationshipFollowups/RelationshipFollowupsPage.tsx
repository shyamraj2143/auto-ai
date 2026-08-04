import {
  Archive,
  ArrowLeft,
  BellRing,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  History,
  LoaderCircle,
  Pause,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  HeartHandshake,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { callNative } from "../calls/services/callNative";
import { relationshipFollowupsApi } from "./relationshipFollowupsApi";
import type {
  ContactChannel,
  ContactFormPayload,
  FollowupCadence,
  FollowupPreferences,
  FollowupPriority,
  FollowupSummary,
  RelationshipContact,
  RelationshipContactDetail,
  RelationshipType,
} from "./types";
import "./relationshipFollowups.css";


const RELATIONSHIP_OPTIONS: Array<[RelationshipType, string]> = [
  ["family", "Family / परिवार"],
  ["friend", "Friend / मित्र"],
  ["relative", "Relative / रिश्तेदार"],
  ["mentor", "Teacher / Mentor"],
  ["colleague", "Colleague / सहकर्मी"],
  ["professional", "Professional contact"],
  ["other", "Other / अन्य"],
];
const CADENCE_OPTIONS: Array<[FollowupCadence, string, number]> = [
  ["weekly", "Every week", 7],
  ["fortnightly", "Every 15 days", 15],
  ["monthly", "Every month", 30],
  ["quarterly", "Every 3 months", 90],
  ["custom", "Custom interval", 30],
];
const PRIORITY_OPTIONS: Array<[FollowupPriority, string]> = [["normal", "Normal"], ["important", "Important"], ["high", "High"]];
const CHANNEL_OPTIONS: Array<[ContactChannel, string]> = [["phone", "Phone"], ["email", "Email"], ["whatsapp", "WhatsApp"], ["other", "Other"]];

function defaultLocalDateTime() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  date.setHours(10, 0, 0, 0);
  return localInputValue(date.toISOString());
}

function localInputValue(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function initialForm(contact?: RelationshipContact | null): ContactFormPayload & { next_local: string; last_local: string } {
  const nextLocal = contact ? localInputValue(contact.next_followup_at) : defaultLocalDateTime();
  return {
    display_name: contact?.display_name ?? "",
    relationship_type: contact?.relationship_type ?? "family",
    preferred_channel: contact?.preferred_channel ?? null,
    contact_value: contact?.contact_value ?? "",
    last_contacted_at: contact?.last_contacted_at ?? null,
    cadence: contact?.cadence ?? "monthly",
    followup_interval_days: contact?.followup_interval_days ?? 30,
    next_followup_at: contact?.next_followup_at ?? new Date(nextLocal).toISOString(),
    preferred_reminder_time: contact?.preferred_reminder_time ?? nextLocal.slice(11, 16),
    timezone: contact?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    priority: contact?.priority ?? "normal",
    notes: contact?.notes ?? "",
    preferred_language: contact?.preferred_language ?? "hi",
    next_local: nextLocal,
    last_local: contact?.last_contacted_at ? localInputValue(contact.last_contacted_at) : "",
  };
}

function formatDate(value: string | null, timezone?: string) {
  if (!value) return "Not recorded";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function validateForm(form: ReturnType<typeof initialForm>) {
  if (form.display_name.trim().length < 2) return "Name must contain at least 2 characters.";
  if (!form.next_local || Number.isNaN(new Date(form.next_local).getTime()) || new Date(form.next_local).getTime() <= Date.now()) return "Choose a future reminder date and time.";
  if (form.cadence === "custom" && (!form.followup_interval_days || form.followup_interval_days < 1 || form.followup_interval_days > 730)) return "Custom interval must be between 1 and 730 days.";
  if (form.contact_value && form.preferred_channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_value)) return "Enter a valid email address.";
  if (form.contact_value && ["phone", "whatsapp"].includes(form.preferred_channel ?? "") && form.contact_value.replace(/\D/g, "").length < 7) return "Enter a valid phone number.";
  return "";
}

function errorText(error: unknown, fallback: string) {
  if (!navigator.onLine) return "You are offline. Saved reminders remain safe; reconnect and retry.";
  return error instanceof Error ? error.message : fallback;
}

function contactHref(contact: RelationshipContact) {
  const value = contact.contact_value.trim();
  if (!value) return null;
  if (contact.preferred_channel === "email") return `mailto:${value}`;
  if (contact.preferred_channel === "phone") return `tel:${value.replace(/[^+\d]/g, "")}`;
  if (contact.preferred_channel === "whatsapp") return `https://wa.me/${value.replace(/\D/g, "")}`;
  return null;
}

function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="rf-modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className={`rf-modal${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="rf-modal-title">
        <header><h2 id="rf-modal-title">{title}</h2><button type="button" onClick={onClose} aria-label="Close dialog"><X /></button></header>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ContactForm({ contact, busy, onCancel, onSave }: { contact?: RelationshipContact | null; busy: boolean; onCancel: () => void; onSave: (payload: ContactFormPayload) => Promise<void> }) {
  const [form, setForm] = useState(() => initialForm(contact));
  const [error, setError] = useState("");
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const validation = validateForm(form);
    if (validation) { setError(validation); return; }
    setError("");
    const { next_local, last_local, ...payload } = form;
    await onSave({
      ...payload,
      display_name: payload.display_name.trim(),
      contact_value: payload.contact_value.trim(),
      notes: payload.notes.trim(),
      next_followup_at: new Date(next_local).toISOString(),
      last_contacted_at: last_local ? new Date(last_local).toISOString() : null,
      preferred_reminder_time: next_local.slice(11, 16),
      followup_interval_days: payload.cadence === "custom" ? payload.followup_interval_days : CADENCE_OPTIONS.find(([value]) => value === payload.cadence)?.[2] ?? 30,
    });
  };
  return (
    <form className="rf-form" onSubmit={(event) => void submit(event)} noValidate>
      {error && <p className="rf-form-error" role="alert">{error}</p>}
      <div className="rf-form-grid">
        <label className="rf-span-2">Name / नाम<input value={form.display_name} maxLength={120} autoComplete="name" onChange={(e) => set("display_name", e.target.value)} required aria-invalid={Boolean(error && form.display_name.trim().length < 2)} /></label>
        <label>Relationship<select value={form.relationship_type} onChange={(e) => set("relationship_type", e.target.value as RelationshipType)}>{RELATIONSHIP_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Priority<select value={form.priority} onChange={(e) => set("priority", e.target.value as FollowupPriority)}>{PRIORITY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Contact method<select value={form.preferred_channel ?? ""} onChange={(e) => set("preferred_channel", (e.target.value || null) as ContactChannel | null)}><option value="">None (manual only)</option>{CHANNEL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Optional contact detail<input value={form.contact_value} maxLength={320} inputMode={form.preferred_channel === "email" ? "email" : form.preferred_channel === "phone" || form.preferred_channel === "whatsapp" ? "tel" : "text"} autoComplete="off" onChange={(e) => set("contact_value", e.target.value)} /><small>Stored privately</small></label>
        <label>Last contacted<input type="datetime-local" value={form.last_local} onChange={(e) => set("last_local", e.target.value)} /></label>
        <label>Next reminder<input type="datetime-local" value={form.next_local} min={localInputValue(new Date(Date.now() + 60_000).toISOString())} onChange={(e) => set("next_local", e.target.value)} required /></label>
        <label>Frequency<select value={form.cadence} onChange={(e) => set("cadence", e.target.value as FollowupCadence)}>{CADENCE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {form.cadence === "custom" && <label>Custom days<input type="number" min={1} max={730} value={form.followup_interval_days ?? 30} onChange={(e) => set("followup_interval_days", Number(e.target.value))} /></label>}
        <label>Timezone<input value={form.timezone} readOnly aria-describedby="rf-timezone-help" /><small id="rf-timezone-help">Detected from this device</small></label>
        <label>Message language<select value={form.preferred_language} onChange={(e) => set("preferred_language", e.target.value as "hi" | "en")}><option value="hi">Hindi</option><option value="en">English</option></select></label>
        <label className="rf-span-2">Private note<textarea value={form.notes} maxLength={4000} rows={3} onChange={(e) => set("notes", e.target.value)} /><small>Only you can see this context</small></label>
      </div>
      <footer><button type="button" className="rf-secondary" onClick={onCancel}>Cancel</button><button type="submit" className="rf-primary" disabled={busy}>{busy ? <><LoaderCircle className="spin" /> Saving…</> : contact ? "Save changes" : "Add person"}</button></footer>
    </form>
  );
}

export function RelationshipFollowupsPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<RelationshipContact[]>([]);
  const [summary, setSummary] = useState<FollowupSummary | null>(null);
  const [preferences, setPreferences] = useState<FollowupPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [relationship, setRelationship] = useState("");
  const [priority, setPriority] = useState("");
  const [bucket, setBucket] = useState("");
  const [sort, setSort] = useState("due_asc");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [editing, setEditing] = useState<RelationshipContact | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<RelationshipContactDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [interactionNote, setInteractionNote] = useState("");
  const [rescheduleLocal, setRescheduleLocal] = useState("");
  const [aiContext, setAiContext] = useState("");
  const [aiTone, setAiTone] = useState<"friendly" | "formal" | "caring">("friendly");
  const [aiSuggestion, setAiSuggestion] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [permissionExplainer, setPermissionExplainer] = useState(false);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [requiresSettings, setRequiresSettings] = useState(false);
  const settingsRef = useRef<HTMLElement>(null);
  const openedDeepLinkRef = useRef("");

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [list, nextSummary, nextPreferences] = await Promise.all([
        relationshipFollowupsApi.list(token, { query, relationshipType: relationship, priority, bucket, sort, page }, signal),
        relationshipFollowupsApi.summary(token, signal),
        relationshipFollowupsApi.preferences(token),
      ]);
      setItems(list.items);
      setTotal(list.total);
      setSummary(nextSummary);
      setPreferences(nextPreferences);
    } catch (loadError) {
      if ((loadError as Error)?.name !== "AbortError") setError(errorText(loadError, "Relationship follow-ups could not be loaded."));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [bucket, page, priority, query, relationship, sort, token]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(controller.signal), query ? 250 : 0);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [load, query]);

  useEffect(() => {
    if (new URLSearchParams(location.search).get("settings") === "notifications") settingsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    if ((location.state as { addPerson?: boolean } | null)?.addPerson) {
      setEditing(null);
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [loading, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (!token) return;
    const contactId = new URLSearchParams(location.search).get("contact")?.trim() ?? "";
    if (!contactId || openedDeepLinkRef.current === contactId) return;
    openedDeepLinkRef.current = contactId;
    setDetailLoading(true);
    void relationshipFollowupsApi.detail(token, contactId)
      .then((detail) => {
        setSelected(detail);
        setRescheduleLocal(localInputValue(detail.next_followup_at));
      })
      .catch((detailError) => {
        openedDeepLinkRef.current = "";
        setError(errorText(detailError, "The reminder destination could not be opened."));
      })
      .finally(() => setDetailLoading(false));
  }, [location.search, token]);

  const openDetail = useCallback(async (contact: RelationshipContact) => {
    if (!token) return;
    setDetailLoading(true);
    setSelected({ ...contact, interactions: [], events: [] });
    setAiSuggestion("");
    setAiModel("");
    setRescheduleLocal(localInputValue(contact.next_followup_at));
    try {
      setSelected(await relationshipFollowupsApi.detail(token, contact.id));
    } catch (detailError) {
      setError(errorText(detailError, "Details could not be loaded."));
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  }, [token]);

  const refreshAfterAction = async (updated?: RelationshipContact) => {
    await load();
    if (updated && selected?.id === updated.id) await openDetail(updated);
  };

  const runAction = async (label: string, action: () => Promise<RelationshipContact>, success: string) => {
    setActionBusy(label);
    setError("");
    try {
      const updated = await action();
      setNotice(success);
      await refreshAfterAction(updated);
    } catch (actionError) {
      setError(errorText(actionError, "The action could not be completed."));
    } finally {
      setActionBusy("");
    }
  };

  const saveContact = async (payload: ContactFormPayload) => {
    if (!token) return;
    setSaving(true);
    setError("");
    try {
      const saved = editing ? await relationshipFollowupsApi.update(token, editing, payload) : await relationshipFollowupsApi.create(token, payload);
      setEditing(undefined);
      setNotice(editing ? "Follow-up updated." : "Person added and reminder scheduled.");
      await load();
      await openDetail(saved);
    } catch (saveError) {
      setError(errorText(saveError, "Follow-up could not be saved."));
    } finally {
      setSaving(false);
    }
  };

  const updatePreferences = async (next: Pick<FollowupPreferences, "enabled" | "detailed_preview" | "permission_state">) => {
    if (!token) return;
    try {
      setPreferences(await relationshipFollowupsApi.updatePreferences(token, next));
      setNotice("Reminder preference saved.");
    } catch (preferenceError) {
      setError(errorText(preferenceError, "Reminder preference could not be saved."));
    }
  };

  const enablePush = async () => {
    if (!token || !preferences) return;
    setPermissionBusy(true);
    setError("");
    try {
      if (!callNative.isAndroid()) {
        await updatePreferences({ enabled: false, detailed_preview: preferences.detailed_preview, permission_state: "unsupported" });
        setNotice("Web push is unsupported. In-app due reminders remain available without permission.");
        setPermissionExplainer(false);
        return;
      }
      const checked = await callNative.checkCallPermissions(false);
      let permission = checked.notifications;
      if (!permission.granted && permission.permanentlyDenied) {
        setRequiresSettings(true);
        await updatePreferences({ enabled: false, detailed_preview: preferences.detailed_preview, permission_state: "permanent_denial" });
        return;
      }
      if (!permission.granted && permission.canAskAgain) permission = (await callNative.requestNotificationPermission()).notifications;
      if (permission.granted) {
        setRequiresSettings(false);
        await updatePreferences({ enabled: true, detailed_preview: preferences.detailed_preview, permission_state: "granted" });
        setPermissionExplainer(false);
      } else {
        setRequiresSettings(permission.permanentlyDenied);
        await updatePreferences({ enabled: false, detailed_preview: preferences.detailed_preview, permission_state: permission.permanentlyDenied ? "permanent_denial" : "denied" });
      }
    } catch (permissionError) {
      setError(errorText(permissionError, "Notification permission could not be checked."));
    } finally {
      setPermissionBusy(false);
    }
  };

  const generateSuggestion = async () => {
    if (!token || !selected) return;
    setActionBusy("ai");
    setError("");
    try {
      const result = await relationshipFollowupsApi.suggest(token, selected.id, { language: selected.preferred_language, tone: aiTone, context: aiContext.trim() });
      setAiSuggestion(result.suggestion);
      setAiModel(result.model);
    } catch (aiError) {
      setError(errorText(aiError, "AI suggestion is unavailable. You can still write a message manually."));
    } finally {
      setActionBusy("");
    }
  };

  const shareSuggestion = async () => {
    if (!aiSuggestion) return;
    try {
      if (navigator.share) await navigator.share({ text: aiSuggestion });
      else { await navigator.clipboard.writeText(aiSuggestion); setNotice("Message copied. Review it before sending."); }
    } catch (shareError) {
      if ((shareError as DOMException)?.name !== "AbortError") setError("The system share sheet could not be opened.");
    }
  };

  const summaryCards = useMemo(() => [
    ["today", "Due today", summary?.today ?? 0, CalendarClock],
    ["overdue", "Overdue", summary?.overdue ?? 0, Clock3],
    ["upcoming", "Upcoming", summary?.upcoming ?? 0, BellRing],
  ] as const, [summary]);

  return (
    <div className="rf-page">
      <header className="rf-header">
        <button type="button" className="rf-icon-button" onClick={() => navigate("/hub")} aria-label="Back to Action Hub"><ArrowLeft /></button>
        <div><p>Social life & family</p><h1><HeartHandshake /> Relationship Follow-up</h1><span>Stay connected intentionally. No contacts permission required.</span></div>
        <button type="button" className="rf-primary" onClick={() => setEditing(null)}><Plus /> Add person</button>
      </header>

      {!navigator.onLine && <div className="rf-offline" role="status">Offline — saved data remains available after reconnecting.</div>}
      {error && <div className="rf-alert" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}><RefreshCw /> Retry</button></div>}
      {notice && <div className="rf-notice" role="status"><CheckCircle2 /> {notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X /></button></div>}

      <main className="rf-content">
        <section className="rf-summary" aria-label="Follow-up summary">
          {summaryCards.map(([value, label, count, Icon]) => <button type="button" key={value} className={bucket === value ? "active" : ""} onClick={() => { setBucket(bucket === value ? "" : value); setPage(1); }} aria-pressed={bucket === value}><span><Icon /> {label}</span><strong>{loading ? "—" : count}</strong></button>)}
        </section>

        <section className="rf-toolbar" aria-label="Search and filters">
          <label className="rf-search"><Search aria-hidden="true" /><span className="sr-only">Search people</span><input value={query} aria-label="Search people" onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></label>
          <label><span className="sr-only">Relationship filter</span><select value={relationship} onChange={(e) => { setRelationship(e.target.value); setPage(1); }}><option value="">All relationships</option>{RELATIONSHIP_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span className="sr-only">Priority filter</span><select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }}><option value="">All priorities</option>{PRIORITY_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label><span className="sr-only">Sort by due date</span><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="due_asc">Due first</option><option value="due_desc">Latest first</option></select></label>
          <button type="button" className={bucket === "paused" ? "active" : ""} onClick={() => setBucket(bucket === "paused" ? "" : "paused")}>Paused</button>
          <button type="button" className={bucket === "archived" ? "active" : ""} onClick={() => setBucket(bucket === "archived" ? "" : "archived")}>Archived</button>
        </section>

        <section className="rf-list" aria-label="Relationship follow-ups" aria-busy={loading}>
          {loading ? <div className="rf-loading" role="status"><LoaderCircle className="spin" /> Loading follow-ups…</div> : items.length === 0 ? (
            <div className="rf-empty"><HeartHandshake /><h2>{query || relationship || priority || bucket ? "No matching follow-ups" : "Add someone important"}</h2><p>{query || relationship || priority || bucket ? "Change your search or filters and try again." : "Manual entry works without contacts, call-log or message permissions."}</p>{!query && !relationship && !priority && !bucket && <button type="button" className="rf-primary" onClick={() => setEditing(null)}><Plus /> Add first person</button>}</div>
          ) : <div className="rf-card-grid">{items.map((contact) => {
            const overdue = contact.status === "active" && new Date(contact.next_followup_at).getTime() < Date.now();
            return <article className={`rf-contact-card priority-${contact.priority}`} key={contact.id}>
              <header><span className="rf-avatar">{contact.display_name.slice(0, 1).toUpperCase()}</span><div><h2>{contact.display_name}</h2><p>{RELATIONSHIP_OPTIONS.find(([value]) => value === contact.relationship_type)?.[1] ?? contact.relationship_type}</p></div><b className={`rf-status status-${contact.status}`}>{contact.status}</b></header>
              <div className="rf-due"><CalendarClock /><span><small>{overdue ? "Overdue" : contact.status === "paused" ? "Reminder paused" : contact.status === "archived" ? "Archived" : "Next follow-up"}</small><strong>{formatDate(contact.next_followup_at, contact.timezone)}</strong></span></div>
              <p className="rf-cadence">{CADENCE_OPTIONS.find(([value]) => value === contact.cadence)?.[1]} · {contact.priority}</p>
              <footer>{contact.status === "active" && <button type="button" className="rf-primary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction(`contact-${contact.id}`, () => relationshipFollowupsApi.contacted(token, contact, ""), "Contact recorded; the next reminder is scheduled.")}><CheckCircle2 /> Contacted</button>}<button type="button" className="rf-secondary" onClick={() => void openDetail(contact)}>Details</button><button type="button" className="rf-icon-button" onClick={() => setEditing(contact)} aria-label={`Edit ${contact.display_name}`}><Pencil /></button></footer>
            </article>;
          })}</div>}
          {!loading && total > 30 && <nav className="rf-pagination" aria-label="Follow-up pages"><button type="button" disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {page} of {Math.ceil(total / 30)}</span><button type="button" disabled={page * 30 >= total} onClick={() => setPage((value) => value + 1)}>Next</button></nav>}
        </section>

        <section ref={settingsRef} className="rf-preferences" aria-labelledby="rf-preferences-title">
          <div><Settings /><span><h2 id="rf-preferences-title">Reminder notifications</h2><p>In-app reminders always work. Android push is optional and requested only when you enable it.</p></span></div>
          <div className="rf-preference-controls">
            <button type="button" className={`rf-toggle${preferences?.enabled ? " active" : ""}`} role="switch" aria-checked={preferences?.enabled ?? false} onClick={() => preferences?.enabled ? void updatePreferences({ enabled: false, detailed_preview: preferences.detailed_preview, permission_state: preferences.permission_state }) : setPermissionExplainer(true)}><span />{preferences?.enabled ? "Push on" : "Enable push"}</button>
            <label className="rf-check"><input type="checkbox" checked={preferences?.detailed_preview ?? false} onChange={(e) => preferences && void updatePreferences({ enabled: preferences.enabled, detailed_preview: e.target.checked, permission_state: preferences.permission_state })} /> Show person name in notification</label>
          </div>
          {preferences?.permission_state && preferences.permission_state !== "unknown" && <small>Permission state: {preferences.permission_state.replace(/_/g, " ")}</small>}
        </section>
      </main>

      {editing !== undefined && <Modal title={editing ? "Edit follow-up" : "Add important person"} onClose={() => setEditing(undefined)}><ContactForm contact={editing} busy={saving} onCancel={() => setEditing(undefined)} onSave={saveContact} /></Modal>}

      {selected && <Modal title={selected.display_name} onClose={() => setSelected(null)} wide>
        {detailLoading ? <div className="rf-loading"><LoaderCircle className="spin" /> Loading details…</div> : <div className="rf-detail">
          <section className="rf-detail-hero"><div><span>{RELATIONSHIP_OPTIONS.find(([value]) => value === selected.relationship_type)?.[1]}</span><strong>Next: {formatDate(selected.next_followup_at, selected.timezone)}</strong><small>Last contacted: {formatDate(selected.last_contacted_at, selected.timezone)}</small></div>{contactHref(selected) && <a className="rf-secondary" href={contactHref(selected) ?? undefined} target={selected.preferred_channel === "whatsapp" ? "_blank" : undefined} rel="noreferrer"><ExternalLink /> Open {selected.preferred_channel}</a>}</section>
          {selected.notes && <section className="rf-private-note"><h3>Private context</h3><p>{selected.notes}</p></section>}
          <section className="rf-detail-actions" aria-label="Reminder actions">
            {selected.status === "active" && <><label>Optional interaction note<input value={interactionNote} maxLength={2000} onChange={(e) => setInteractionNote(e.target.value)} /></label><button type="button" className="rf-primary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction("contacted", () => relationshipFollowupsApi.contacted(token, selected, interactionNote), "Contact recorded and next reminder calculated.")}><CheckCircle2 /> Mark contacted</button><button type="button" className="rf-secondary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction("snooze", () => relationshipFollowupsApi.snooze(token, selected, 1440), "Reminder snoozed for one day.")}><Clock3 /> Snooze 1 day</button><button type="button" className="rf-secondary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction("pause", () => relationshipFollowupsApi.status(token, selected, "pause"), "Follow-up paused.")}><Pause /> Pause</button></>}
            {selected.status === "paused" && <button type="button" className="rf-primary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction("resume", () => relationshipFollowupsApi.status(token, selected, "resume"), "Follow-up resumed.")}>Resume</button>}
            {selected.status !== "archived" ? <button type="button" className="rf-danger" disabled={Boolean(actionBusy)} onClick={() => window.confirm(`Archive ${selected.display_name}? Future reminders will stop.`) && token && void runAction("archive", () => relationshipFollowupsApi.status(token, selected, "archive"), "Follow-up archived.")}><Archive /> Archive</button> : <button type="button" className="rf-primary" disabled={Boolean(actionBusy)} onClick={() => token && void runAction("restore", () => relationshipFollowupsApi.status(token, selected, "restore"), "Follow-up restored.")}>Restore</button>}
            <button type="button" className="rf-secondary" onClick={() => { setEditing(selected); setSelected(null); }}><Pencil /> Edit</button>
          </section>
          {selected.status === "active" && <section className="rf-reschedule"><label>Reschedule reminder<input type="datetime-local" min={localInputValue(new Date(Date.now() + 60_000).toISOString())} value={rescheduleLocal} onChange={(e) => setRescheduleLocal(e.target.value)} /></label><button type="button" className="rf-secondary" disabled={!rescheduleLocal || Boolean(actionBusy)} onClick={() => token && void runAction("reschedule", () => relationshipFollowupsApi.reschedule(token, selected, new Date(rescheduleLocal).toISOString()), "Reminder rescheduled.")}>Reschedule</button></section>}
          <section className="rf-ai"><header><Sparkles /><div><h3>AI message suggestion</h3><p>Only name, relationship and context below are sent. Review before sharing; AutoAI never sends automatically.</p></div></header><div className="rf-ai-controls"><select aria-label="Suggestion tone" value={aiTone} onChange={(e) => setAiTone(e.target.value as typeof aiTone)}><option value="friendly">Friendly</option><option value="formal">Formal</option><option value="caring">Caring</option></select><input aria-label="Optional context for the suggestion" value={aiContext} maxLength={500} onChange={(e) => setAiContext(e.target.value)} /><button type="button" className="rf-secondary" disabled={actionBusy === "ai"} onClick={() => void generateSuggestion()}>{actionBusy === "ai" ? <LoaderCircle className="spin" /> : <Sparkles />} Suggest</button></div><textarea aria-label="Editable AI suggestion" value={aiSuggestion} onChange={(e) => setAiSuggestion(e.target.value)} rows={3} />{aiModel && <small>Generated by {aiModel}</small>}<button type="button" className="rf-primary" disabled={!aiSuggestion.trim()} onClick={() => void shareSuggestion()}><Send /> Review in share sheet</button></section>
          <div className="rf-history-grid">
            <section><h3><History /> Interaction history</h3>{selected.interactions.length ? selected.interactions.map((item) => <article key={item.id}><strong>{formatDate(item.contacted_at, selected.timezone)}</strong><span>{item.channel || "Manual"}</span>{item.note && <p>{item.note}</p>}</article>) : <p className="rf-muted">No completed interaction yet.</p>}</section>
            <section><h3><BellRing /> Reminder timeline</h3>{selected.events.length ? selected.events.map((event) => <article key={event.id}><strong>{formatDate(event.scheduled_at, selected.timezone)}</strong><span>{event.status.replace(/_/g, " ")}</span>{event.sent_at && <p>Delivered to a device; completion is not verified until you mark contacted.</p>}{event.failure_code && <p>Delivery issue: {event.failure_code.replace(/_/g, " ")}</p>}{event.status === "failed" && <button type="button" className="rf-secondary" onClick={() => token && void runAction("retry", () => relationshipFollowupsApi.retry(token, selected), "Reminder queued for retry.")}>Retry delivery</button>}</article>) : <p className="rf-muted">No reminder timeline yet.</p>}</section>
          </div>
        </div>}
      </Modal>}

      {permissionExplainer && <Modal title="Enable relationship reminders" onClose={() => !permissionBusy && setPermissionExplainer(false)}>
        <div className="rf-permission"><BellRing /><p>AutoAI needs Android notification permission only to show due follow-ups outside the app. It will not read contacts, messages, call logs or WhatsApp. Manual entry and in-app reminders work if you decline.</p>{requiresSettings && <p className="rf-form-error" role="alert">Permission was permanently denied. AutoAI will not ask again; enable Notifications from Android Settings if you choose.</p>}<footer><button type="button" className="rf-secondary" disabled={permissionBusy} onClick={() => setPermissionExplainer(false)}>Not now</button>{requiresSettings ? <button type="button" className="rf-primary" onClick={() => void callNative.openAppNotificationSettings()}><Settings /> Open Settings</button> : <button type="button" className="rf-primary" disabled={permissionBusy} onClick={() => void enablePush()}>{permissionBusy ? <><LoaderCircle className="spin" /> Checking…</> : "Continue"}</button>}</footer></div>
      </Modal>}
    </div>
  );
}
