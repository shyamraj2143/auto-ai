import { AlarmClock, ArrowLeft, BellRing, Bot, CalendarDays, Check, Clock3, Edit3, Mic2, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, Volume2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { combineLocalDateTime, countdownLabel, defaultAlarmDate, formatAlarmDate, localDateInput, localTimeInput, quickAlarmDate } from "./alarmTime";
import { useAlarms } from "./AlarmContext";
import type { AlarmDraft, AlarmLanguage, AlarmRingtone, AlarmVoiceStyle, UserAlarm } from "./types";
import "./alarms.css";

type AlarmForm = {
  title: string;
  note: string;
  date: string;
  time: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
};

function freshForm(): AlarmForm {
  const next = defaultAlarmDate();
  return {
    title: "",
    note: "",
    date: localDateInput(next),
    time: localTimeInput(next),
    language: "hinglish-IN",
    voice_style: "warm",
    ringtone: "system",
  };
}

function formForAlarm(alarm: UserAlarm): AlarmForm {
  const date = new Date(alarm.scheduled_at);
  return {
    title: alarm.title,
    note: alarm.note,
    date: localDateInput(date),
    time: localTimeInput(date),
    language: alarm.language,
    voice_style: alarm.voice_style,
    ringtone: alarm.ringtone,
  };
}

export function AlarmPage() {
  const navigate = useNavigate();
  const { alarms, nextAlarm, loading, saving, error, nativeStatus, refresh, createAlarm, updateAlarm, deleteAlarm, previewAlarm, requestAlarmAccess } = useAlarms();
  const [form, setForm] = useState<AlarmForm>(freshForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  const activeAlarms = useMemo(() => alarms.filter((alarm) => !["completed", "cancelled"].includes(alarm.status)), [alarms]);
  const permissionReady = !nativeStatus || nativeStatus.ready;
  const lockScreenReady = !nativeStatus || !nativeStatus.fullScreenRequired || nativeStatus.fullScreenGranted;

  const updateField = <K extends keyof AlarmForm>(key: K, value: AlarmForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const reset = () => {
    setEditingId(null);
    setForm(freshForm());
    setFormError("");
  };

  const useQuickTime = (kind: "tomorrow-morning" | "today-evening" | "next-hour") => {
    const value = quickAlarmDate(kind);
    setForm((current) => ({ ...current, date: localDateInput(value), time: localTimeInput(value) }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    setSavedMessage("");
    const scheduled = combineLocalDateTime(form.date, form.time);
    if (!form.title.trim()) {
      setFormError("Give this alarm a clear title.");
      return;
    }
    if (!scheduled || scheduled.getTime() < Date.now() + 20_000) {
      setFormError("Choose a future date and time.");
      return;
    }
    const payload: AlarmDraft = {
      title: form.title.trim(),
      note: form.note.trim(),
      scheduled_at: scheduled.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      language: form.language,
      voice_style: form.voice_style,
      ringtone: form.ringtone,
    };
    try {
      const saved = editingId ? await updateAlarm(editingId, payload) : await createAlarm(payload);
      setSavedMessage(`${editingId ? "Alarm updated" : "AI alarm ready"}: ${saved.assistant_message}`);
      reset();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Alarm could not be saved.");
    }
  };

  const edit = (alarm: UserAlarm) => {
    setEditingId(alarm.id);
    setForm(formForAlarm(alarm));
    setFormError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="alarm-page">
      <header className="alarm-page-header">
        <button type="button" onClick={() => navigate("/hub")} aria-label="Back to Action Hub"><ArrowLeft /></button>
        <span><AlarmClock /><span><strong>AI Alarm</strong><small>Personal Assistant</small></span></span>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh alarms"><RefreshCw /></button>
      </header>

      <main className="alarm-page-main">
        <section className="alarm-hero">
          <div>
            <p><Sparkles /> AI-powered wake-up assistant</p>
            <h1>Wake up with a reason,<br />not just a ringtone.</h1>
            <span>Set the date, time and purpose. AutoAI prepares a natural reminder in your language and speaks it when the alarm rings.</span>
          </div>
          <aside className="alarm-next-card">
            <span><BellRing /> Next alarm</span>
            {nextAlarm ? (
              <>
                <strong>{new Date(nextAlarm.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong>
                <p>{nextAlarm.title}</p>
                <small>{countdownLabel(nextAlarm.scheduled_at)} · {formatAlarmDate(nextAlarm.scheduled_at)}</small>
              </>
            ) : <div className="alarm-next-empty"><Clock3 /><p>No upcoming alarm</p><small>Create one below</small></div>}
          </aside>
        </section>

        {(!permissionReady || !lockScreenReady) && nativeStatus && (
          <section className="alarm-access-card" role="status">
            <span><ShieldCheck /></span>
            <div><strong>{permissionReady ? "Enable the lock-screen alarm" : "Finish reliable alarm access"}</strong><p>Allow notifications, camera, exact alarms and the full-screen alarm window. AutoAI will not claim an alarm is armed until exact timing is available.</p></div>
            <button type="button" onClick={() => void requestAlarmAccess()}>Enable access</button>
          </section>
        )}

        <section className="alarm-workspace-grid">
          <form className="alarm-form-card" onSubmit={submit}>
            <header><span><Plus /></span><div><strong>{editingId ? "Edit AI alarm" : "Create an AI alarm"}</strong><small>Calendar, ringtone and personal voice reminder</small></div></header>

            <label className="alarm-field"><span>What should I remind you about?</span><input value={form.title} onChange={(event) => updateField("title", event.target.value)} placeholder="Office, exam, medicine..." maxLength={120} required /></label>
            <label className="alarm-field"><span>Personal context</span><textarea value={form.note} onChange={(event) => updateField("note", event.target.value)} placeholder="Example: I have to leave for the office by 8:30 AM." maxLength={1000} rows={3} /></label>

            <div className="alarm-date-grid">
              <label className="alarm-field"><span><CalendarDays /> Date</span><input type="date" min={localDateInput(new Date())} value={form.date} onChange={(event) => updateField("date", event.target.value)} required /></label>
              <label className="alarm-field"><span><Clock3 /> Time</span><input type="time" value={form.time} onChange={(event) => updateField("time", event.target.value)} required /></label>
            </div>

            <div className="alarm-quick-times" aria-label="Quick alarm times">
              <button type="button" onClick={() => useQuickTime("tomorrow-morning")}>Tomorrow · 7:00 AM</button>
              <button type="button" onClick={() => useQuickTime("today-evening")}>Evening · 6:00 PM</button>
              <button type="button" onClick={() => useQuickTime("next-hour")}>Next hour</button>
            </div>

            <div className="alarm-option-grid">
              <label className="alarm-field"><span>Language</span><select value={form.language} onChange={(event) => updateField("language", event.target.value as AlarmLanguage)}><option value="hinglish-IN">Hinglish</option><option value="hi-IN">Hindi</option><option value="en-IN">English</option></select></label>
              <label className="alarm-field"><span>Voice feeling</span><select value={form.voice_style} onChange={(event) => updateField("voice_style", event.target.value as AlarmVoiceStyle)}><option value="warm">Warm & human</option><option value="gentle">Gentle</option><option value="energetic">Energetic</option></select></label>
              <label className="alarm-field"><span>Ringtone</span><select value={form.ringtone} onChange={(event) => updateField("ringtone", event.target.value as AlarmRingtone)}><option value="system">System alarm</option><option value="gentle">Gentle rise</option><option value="energetic">Energetic</option></select></label>
            </div>

            <div className="alarm-ai-note"><Bot /><span><strong>Groq reminder model</strong><small>AutoAI will turn your context into one short, natural spoken reminder. A safe local message is used if AI is temporarily unavailable.</small></span></div>
            {(formError || error) && <p className="alarm-form-error" role="alert">{formError || error}</p>}
            {savedMessage && <p className="alarm-form-success" role="status"><Check /> {savedMessage}</p>}
            <div className="alarm-form-actions">
              {editingId && <button type="button" className="alarm-cancel-edit" onClick={reset}>Cancel</button>}
              <button type="submit" className="alarm-save-button" disabled={saving}>{saving ? "Preparing alarm..." : editingId ? "Save changes" : "Create AI alarm"}</button>
            </div>
          </form>

          <section className="alarm-list-card">
            <header><div><strong>My alarms</strong><small>{activeAlarms.length} active alarm{activeAlarms.length === 1 ? "" : "s"} · synced across your account</small></div><span>{loading ? "Syncing" : "Live"}<i /></span></header>
            {loading ? <div className="alarm-list-empty"><RefreshCw className="alarm-spin" /><p>Syncing alarms...</p></div> : activeAlarms.length === 0 ? <div className="alarm-list-empty"><AlarmClock /><p>No alarms yet</p><small>Your first personal reminder will appear here.</small></div> : (
              <div className="alarm-list">
                {activeAlarms.map((alarm) => (
                  <article key={alarm.id} className={`alarm-row${alarm.enabled ? "" : " is-paused"}`}>
                    <div className="alarm-row-time"><strong>{new Date(alarm.scheduled_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong><small>{formatAlarmDate(alarm.scheduled_at)}</small></div>
                    <div className="alarm-row-copy"><span><strong>{alarm.title}</strong><em>{alarm.ai_generated ? "AI personalized" : "Reliable fallback"}</em></span><p>{alarm.assistant_message}</p><small><Mic2 /> {alarm.language.replace("-IN", "")} · {alarm.voice_style} <Volume2 /> {alarm.ringtone}</small></div>
                    <div className="alarm-row-controls">
                      <button type="button" className={`alarm-toggle${alarm.enabled ? " is-on" : ""}`} onClick={() => void updateAlarm(alarm.id, { enabled: !alarm.enabled }).catch(() => undefined)} aria-label={`${alarm.enabled ? "Pause" : "Enable"} ${alarm.title}`} aria-pressed={alarm.enabled}><span /></button>
                      <button type="button" onClick={() => void previewAlarm(alarm)} aria-label={`Preview ${alarm.title}`}><Volume2 /></button>
                      <button type="button" onClick={() => edit(alarm)} aria-label={`Edit ${alarm.title}`}><Edit3 /></button>
                      <button type="button" className="alarm-delete" onClick={() => { if (window.confirm(`Delete “${alarm.title}”?`)) void deleteAlarm(alarm.id); }} aria-label={`Delete ${alarm.title}`}><Trash2 /></button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </main>
    </div>
  );
}
