import { AlarmClock, ArrowLeft, BellRing, Bot, CalendarDays, Check, Clock3, Edit3, Mic2, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { api } from "../../api/client";
import { alarmsApi } from "./alarmsApi";
import { alarmNative, speakInBrowser } from "./alarmNative";
import { ALARM_WEEKDAYS, countdownLabel, defaultAlarmDate, formatAlarmCalendarDate, formatAlarmDate, formatAlarmTime24, localDateInput, localTimeInput, nextLocalAlarmTime, quickAlarmDate } from "./alarmTime";
import { useAlarms } from "./AlarmContext";
import type { AlarmDraft, AlarmLanguage, AlarmRecurrence, AlarmRingtone, AlarmVoiceStyle, AlarmWeekday, UserAlarm } from "./types";
import "./alarms.css";

type AlarmForm = {
  title: string;
  note: string;
  date: string;
  time: string;
  recurrence_type: AlarmRecurrence;
  selected_weekdays: AlarmWeekday[];
  start_date: string;
  end_date: string;
  language: AlarmLanguage;
  voice_style: AlarmVoiceStyle;
  ringtone: AlarmRingtone;
  repeat: number[];
  snooze_minutes: number;
  snooze_enabled: boolean;
  max_snooze_count: number;
  gradual_volume_enabled: boolean;
  vibration: boolean;
};

function LiveAlarmClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 1_000);
    update();
    return () => window.clearInterval(timer);
  }, []);

  const [hours, minutes, seconds] = formatAlarmTime24(now, true).split(":");
  return (
    <div className="alarm-live-clock" aria-label={`Current time ${hours}:${minutes}:${seconds}, 24-hour format`}>
      <header><span><Clock3 /> Live clock</span><i>24H</i></header>
      <strong><span>{hours}:{minutes}</span><em>:{seconds}</em></strong>
      <small>{formatAlarmCalendarDate(now)} · updates every second</small>
    </div>
  );
}

function Time24Input({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="alarm-time-input-wrapper">
      <input type="time" step="60" required value={value} onChange={(event) => onChange(event.target.value)} aria-describedby="alarm-time-help" />
      <small id="alarm-time-help">Local time</small>
    </div>
  );
}

function freshForm(): AlarmForm {
  const next = defaultAlarmDate();
  return {
    title: "",
    note: "",
    date: "",
    time: localTimeInput(next),
    recurrence_type: "ONCE",
    selected_weekdays: [],
    start_date: "",
    end_date: "",
    language: "hinglish-IN",
    voice_style: "warm",
    ringtone: "system",
    repeat: [], snooze_minutes: 10, snooze_enabled: true, max_snooze_count: 3, gradual_volume_enabled: false, vibration: true,
  };
}

function formForAlarm(alarm: UserAlarm): AlarmForm {
  const date = new Date(alarm.scheduled_at);
  return {
    title: alarm.title,
    note: alarm.note,
    date: alarm.date || "",
    time: localTimeInput(date),
    recurrence_type: alarm.recurrence_type || (alarm.repeat.length ? "CUSTOM" : "ONCE"),
    selected_weekdays: (alarm.selected_weekdays || alarm.repeat).map((day) => ALARM_WEEKDAYS[day]).filter(Boolean),
    start_date: alarm.start_date || "",
    end_date: alarm.end_date || "",
    language: alarm.language,
    voice_style: alarm.voice_style,
    ringtone: alarm.ringtone,
    repeat: alarm.repeat, snooze_minutes: alarm.snooze_minutes, snooze_enabled: alarm.snooze_enabled ?? true, max_snooze_count: alarm.max_snooze_count ?? 3, gradual_volume_enabled: alarm.gradual_volume_enabled ?? false, vibration: alarm.vibration,
  };
}

export function AlarmPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { alarms, nextAlarm, loading, saving, error, nativeStatus, refresh, createAlarm, updateAlarm, deleteAlarm, skipAlarm, previewAlarm, requestAlarmAccess } = useAlarms();
  const [form, setForm] = useState<AlarmForm>(freshForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [assistantState, setAssistantState] = useState<"Ready" | "Listening" | "Correcting" | "Understanding" | "Clarification required" | "Setting alarm" | "Completed" | "Offline" | "Error">("Ready");
  const [assistantText, setAssistantText] = useState("");
  const [assistantReply, setAssistantReply] = useState("Hindi, Hinglish or English mein alarm bolkar set karein.");
  const [assistantAlarm, setAssistantAlarm] = useState<UserAlarm | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const requestIdRef = useRef(crypto.randomUUID());

  const activeAlarms = useMemo(() => alarms.filter((alarm) => !["completed", "cancelled"].includes(alarm.status)), [alarms]);
  const permissionReady = !nativeStatus || nativeStatus.ready;
  const lockScreenReady = !nativeStatus || !nativeStatus.fullScreenRequired || nativeStatus.fullScreenGranted;
  const calculatedNext = useMemo(() => nextLocalAlarmTime({ time: form.time, date: form.date, recurrenceType: form.recurrence_type, selectedWeekdays: form.selected_weekdays, startDate: form.start_date, endDate: form.end_date }), [form.date, form.end_date, form.recurrence_type, form.selected_weekdays, form.start_date, form.time]);

  const updateField = <K extends keyof AlarmForm>(key: K, value: AlarmForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const setWeekdays = (days: readonly AlarmWeekday[]) => updateField("selected_weekdays", [...days]);
  const toggleWeekday = (day: AlarmWeekday) => setForm((current) => ({ ...current, selected_weekdays: current.selected_weekdays.includes(day) ? current.selected_weekdays.filter((item) => item !== day) : ALARM_WEEKDAYS.filter((item) => item === day || current.selected_weekdays.includes(item)) }));
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
    if (!form.title.trim()) {
      setFormError("Give this alarm a clear title.");
      return;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) {
      setFormError("Choose a valid alarm time.");
      return;
    }
    if (form.recurrence_type === "SPECIFIC_DATE" && !form.date) {
      setFormError("Choose a date for a specific-date alarm.");
      return;
    }
    if (form.recurrence_type === "CUSTOM" && form.selected_weekdays.length === 0) {
      setFormError("Select at least one weekday for a custom alarm.");
      return;
    }
    const scheduled = nextLocalAlarmTime({ time: form.time, date: form.date, recurrenceType: form.recurrence_type, selectedWeekdays: form.selected_weekdays, startDate: form.start_date, endDate: form.end_date });
    if (!scheduled || scheduled.getTime() < Date.now() + 20_000) {
      setFormError("This schedule has no future occurrence.");
      return;
    }
    const selectedWeekdays = form.selected_weekdays.map((day) => ALARM_WEEKDAYS.indexOf(day));
    const payload: AlarmDraft = {
      title: form.title.trim(),
      note: form.note.trim(),
      time: form.time,
      date: form.date || null,
      recurrence_type: form.recurrence_type,
      selected_weekdays: selectedWeekdays,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      language: form.language,
      voice_style: form.voice_style,
      ringtone: form.ringtone,
      repeat: selectedWeekdays, snooze_minutes: form.snooze_minutes, snooze_enabled: form.snooze_enabled, max_snooze_count: form.max_snooze_count, gradual_volume_enabled: form.gradual_volume_enabled, vibration: form.vibration,
    };
    try {
      const saved = editingId ? await updateAlarm(editingId, payload) : await createAlarm(payload);
      setSavedMessage(`${editingId ? "Alarm updated" : "AI alarm ready"}: ${saved.assistant_message}`);
      reset();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : "Alarm could not be saved.");
    }
  };

  const runAssistant = async (transcript: string) => {
    const command = transcript.trim();
    if (!token || !command) { setAssistantState("Error"); setAssistantReply("Pehle alarm command boliye ya type kijiye."); return; }
    setAssistantState("Understanding");
    try {
      const result = await alarmsApi.assistantCommand(token, { transcript: command, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", client_request_id: requestIdRef.current, language: form.language });
      setAssistantText(result.normalized_user_text || command);
      if (result.needs_clarification) {
        setAssistantState("Clarification required");
        setAssistantReply(result.clarification_question || result.assistant_reply);
        setAssistantAlarm(null);
        return;
      }
      setAssistantState(result.alarm ? "Setting alarm" : "Completed");
      setAssistantAlarm(result.alarm || null);
      if (result.alarm) {
        const armed = await alarmNative.schedule(result.alarm);
        if (alarmNative.isAndroid() && (!armed.scheduled || !armed.exact)) throw new Error(armed.reason || "Alarm saved but Android exact scheduling failed.");
        await refresh();
        requestIdRef.current = crypto.randomUUID();
      }
      setAssistantReply(result.assistant_reply);
      speakInBrowser(result.assistant_reply, form.language, form.voice_style);
      setAssistantState("Completed");
    } catch (requestError) {
      setAssistantState(typeof navigator !== "undefined" && !navigator.onLine ? "Offline" : "Error");
      setAssistantReply(requestError instanceof Error ? `${requestError.message} Aap command edit karke Retry kar sakte hain.` : "Alarm Assistant connect nahi ho saka. Manual controls kaam kar rahe hain.");
    }
  };

  const stopListening = () => recorderRef.current?.state === "recording" && recorderRef.current.stop();

  const startListening = async () => {
    if (!token) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setAssistantState("Error"); setAssistantReply("Is device par microphone recording support nahi hai. Neeche command type karke alarm set karein."); return; }
    try {
      window.speechSynthesis?.cancel();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      recordingStreamRef.current = stream; recordingChunksRef.current = []; recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        recordingStreamRef.current?.getTracks().forEach((track) => track.stop()); recordingStreamRef.current = null; recorderRef.current = null;
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" }); recordingChunksRef.current = [];
        if (blob.size < 200) { setAssistantState("Error"); setAssistantReply("Awaaz record nahi hui. Mic ke paas bolkar dobara try karein, ya command type karein."); return; }
        setAssistantState("Correcting"); setAssistantReply("Aapki awaaz ko साफ़ command में बदल रहा हूँ…");
        try {
          const result = await api.transcribeAudio(token, blob, recorder.mimeType.includes("ogg") ? "alarm.ogg" : "alarm.webm");
          const transcript = result.text.trim();
          if (!transcript || /[\u0A80-\u0AFF]/u.test(transcript)) {
            setAssistantState("Error"); setAssistantReply("Awaaz sahi Hindi/Hinglish mein transcribe nahi hui. Neeche text ठीक करें या शांत जगह में mic से दोबारा बोलें.");
            return;
          }
          setAssistantState("Understanding");
          await runAssistant(transcript);
        }
        catch (error) { setAssistantState(typeof navigator !== "undefined" && !navigator.onLine ? "Offline" : "Error"); setAssistantReply(error instanceof Error ? `${error.message} Neeche command type karke bhi alarm set kar sakte hain.` : "Voice samajh nahi aayi. Type karke try karein."); }
      };
      recorder.start(250); setAssistantState("Listening"); setAssistantReply("Bolna shuru kijiye… command poori hone par Stop dabayein.");
    } catch (permissionError) {
      setAssistantState("Error");
      setAssistantReply(permissionError instanceof DOMException && permissionError.name === "NotAllowedError" ? "Microphone permission blocked hai. Browser/App Settings mein Microphone Allow karein, ya command type karein." : "Microphone start nahi ho saka. Command type karke alarm set karein.");
    }
  };

  useEffect(() => () => { stopListening(); recordingStreamRef.current?.getTracks().forEach((track) => track.stop()); }, []);

  const edit = (alarm: UserAlarm) => {
    setEditingId(alarm.id);
    setForm(formForAlarm(alarm));
    setFormError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const duplicate = async (alarm: UserAlarm) => {
    const payload: AlarmDraft = {
      title: `${alarm.title} copy`.slice(0, 120), note: alarm.note, time: alarm.time,
      date: alarm.date || null, recurrence_type: alarm.recurrence_type,
      selected_weekdays: alarm.selected_weekdays, start_date: alarm.start_date || null, end_date: alarm.end_date || null,
      timezone: alarm.timezone, language: alarm.language, voice_style: alarm.voice_style, ringtone: alarm.ringtone,
      repeat: alarm.selected_weekdays, snooze_minutes: alarm.snooze_minutes, snooze_enabled: alarm.snooze_enabled,
      max_snooze_count: alarm.max_snooze_count, gradual_volume_enabled: alarm.gradual_volume_enabled, vibration: alarm.vibration,
    };
    try { await createAlarm(payload); setSavedMessage(`Duplicated ${alarm.title}.`); }
    catch (requestError) { setFormError(requestError instanceof Error ? requestError.message : "Alarm could not be duplicated."); }
  };

  return (
    <div className="alarm-page">
      <header className="alarm-page-header">
        <button type="button" onClick={() => navigate("/hub")} aria-label="Back to Action Hub"><ArrowLeft /></button>
        <span><AlarmClock /><span><strong>AI Alarm</strong><small>Personal Assistant</small></span></span>
        <button type="button" onClick={() => void refresh()} aria-label="Refresh alarms"><RefreshCw /></button>
      </header>

      <main className="alarm-page-main">
        <section className="alarm-assistant-card">
          <header><span><Bot /></span><div><strong>Alarm Assistant</strong><small>{assistantState}</small></div></header>
          <button type="button" className={`alarm-assistant-mic${assistantState === "Listening" ? " is-listening" : ""}`} onClick={() => assistantState === "Listening" ? stopListening() : void startListening()} disabled={["Correcting","Understanding","Setting alarm"].includes(assistantState)} aria-label={assistantState === "Listening" ? "Stop listening" : "Start Alarm Assistant"}>{assistantState === "Listening" ? <X /> : <Mic2 />}</button>
          <p>{assistantReply}</p>{assistantText && <blockquote><span>आपकी बात समझी गई:</span> “{assistantText}” <button type="button" onClick={() => document.querySelector<HTMLInputElement>('.alarm-assistant-text input')?.focus()}>Edit</button></blockquote>}
          <form className="alarm-assistant-text" onSubmit={(event)=>{event.preventDefault();void runAssistant(assistantText)}}><input value={assistantText} onChange={(event)=>{setAssistantText(event.target.value);setAssistantState("Ready");requestIdRef.current=crypto.randomUUID()}} placeholder="Type: kal subah 8 baje office ka alarm lagao" aria-label="Alarm command"/><button type="submit" disabled={!assistantText.trim() || ["Correcting","Understanding","Setting alarm"].includes(assistantState)}>{assistantState === "Error" || assistantState === "Offline" ? "Retry" : "Set alarm"}</button></form>
          {assistantAlarm && <article className="alarm-assistant-preview"><div><strong>{formatAlarmTime24(assistantAlarm.scheduled_at)}</strong><span>{formatAlarmCalendarDate(assistantAlarm.scheduled_at)} · {countdownLabel(assistantAlarm.scheduled_at)}</span></div><p>{assistantAlarm.title}</p><small>Repeat: {assistantAlarm.repeat.length ? assistantAlarm.repeat.map((day)=>["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][day]).join(", ") : "Once"} · {assistantAlarm.ringtone} · Vibration {assistantAlarm.vibration ? "on" : "off"} · Snooze {assistantAlarm.snooze_minutes} min</small><nav><button type="button" onClick={()=>edit(assistantAlarm)}>Edit</button><button type="button" onClick={()=>void updateAlarm(assistantAlarm.id,{enabled:false})}>Disable</button><button type="button" onClick={()=>void deleteAlarm(assistantAlarm.id).then(()=>setAssistantAlarm(null))}>Delete</button></nav></article>}
          <small>Example: “कल सुबह 8 बजे ऑफिस का alarm लगाओ” · Voice is used only during this visible session and is not stored.</small>
        </section>
        <section className="alarm-hero">
          <div>
            <p><Sparkles /> AI-powered wake-up assistant</p>
            <h1>Wake up with a reason,<br />not just a ringtone.</h1>
            <span>Set the date, time and purpose. AutoAI prepares a natural reminder in your language and speaks it when the alarm rings.</span>
          </div>
          <aside className="alarm-next-card">
            <LiveAlarmClock />
            <div className="alarm-next-summary">
              <span><BellRing /> Next alarm</span>
              {nextAlarm ? (
                <>
                  <strong>{formatAlarmTime24(nextAlarm.scheduled_at)}</strong>
                  <p>{nextAlarm.title}</p>
                  <small>{countdownLabel(nextAlarm.scheduled_at)} · {formatAlarmDate(nextAlarm.scheduled_at)}</small>
                </>
              ) : <div className="alarm-next-empty"><Clock3 /><p>No upcoming alarm</p><small>Create one below</small></div>}
            </div>
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
            <label className="alarm-field"><span>Personal context</span><textarea value={form.note} onChange={(event) => updateField("note", event.target.value)} placeholder="Example: I have to leave for the office by 08:30." maxLength={1000} rows={3} /></label>

            <div className="alarm-date-grid">
              <label className="alarm-field"><span><CalendarDays /> Date <em>Optional</em></span><div className="alarm-date-input"><input type="date" min={localDateInput(new Date())} value={form.date} onChange={(event) => updateField("date", event.target.value)} aria-describedby="alarm-date-help" />{form.date && <button type="button" onClick={() => updateField("date", "")} aria-label="Clear alarm date"><X /></button>}</div><small id="alarm-date-help">Leave empty to use the next future occurrence.</small></label>
              <div className="alarm-field"><span><Clock3 /> Time (24-hour)</span><Time24Input value={form.time} onChange={(value) => updateField("time", value)} /></div>
            </div>

            <div className="alarm-quick-times" aria-label="Quick alarm times">
              <button type="button" onClick={() => useQuickTime("tomorrow-morning")}>Tomorrow · 07:00</button>
              <button type="button" onClick={() => useQuickTime("today-evening")}>Evening · 18:00</button>
              <button type="button" onClick={() => useQuickTime("next-hour")}>Next hour</button>
            </div>

            <div className="alarm-option-grid">
              <label className="alarm-field"><span>Repeat</span><select value={form.recurrence_type} onChange={(event) => updateField("recurrence_type", event.target.value as AlarmRecurrence)}><option value="ONCE">Once</option><option value="SPECIFIC_DATE">Specific date</option><option value="DAILY">Every day</option><option value="WEEKDAYS">Weekdays</option><option value="WEEKENDS">Weekends</option><option value="CUSTOM">Custom days</option></select></label>
              <label className="alarm-field"><span>Language</span><select value={form.language} onChange={(event) => updateField("language", event.target.value as AlarmLanguage)}><option value="hinglish-IN">Hinglish</option><option value="hi-IN">Hindi</option><option value="en-IN">English</option></select></label>
              <label className="alarm-field"><span>Voice feeling</span><select value={form.voice_style} onChange={(event) => updateField("voice_style", event.target.value as AlarmVoiceStyle)}><option value="warm">Warm & human</option><option value="gentle">Gentle</option><option value="energetic">Energetic</option></select></label>
              <label className="alarm-field"><span>Ringtone</span><select value={form.ringtone} onChange={(event) => updateField("ringtone", event.target.value as AlarmRingtone)}><option value="system">System alarm</option><option value="gentle">Gentle rise</option><option value="energetic">Energetic</option></select></label>
              <label className="alarm-field"><span>Snooze</span><select value={form.snooze_enabled ? form.snooze_minutes : 0} onChange={(event) => { const value = Number(event.target.value); updateField("snooze_enabled", value > 0); if (value > 0) updateField("snooze_minutes", value); }}><option value={0}>Off</option><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option></select></label>
              <label className="alarm-field"><span>Vibration</span><select value={String(form.vibration)} onChange={(event) => updateField("vibration", event.target.value === "true")}><option value="true">On</option><option value="false">Off</option></select></label>
            </div>
            {form.recurrence_type === "CUSTOM" && <fieldset className="alarm-repeat"><legend>Repeat weekdays</legend><nav aria-label="Weekday shortcuts"><button type="button" onClick={() => setWeekdays(ALARM_WEEKDAYS)}>All</button><button type="button" onClick={() => setWeekdays(ALARM_WEEKDAYS.slice(0, 5))}>Weekdays</button><button type="button" onClick={() => setWeekdays(ALARM_WEEKDAYS.slice(5))}>Weekends</button><button type="button" onClick={() => setWeekdays([])}>Clear</button></nav>{ALARM_WEEKDAYS.map((day,index)=>{const selected=form.selected_weekdays.includes(day);return <button type="button" key={day} aria-pressed={selected} aria-label={`${selected ? "Deselect" : "Select"} ${day.toLowerCase()}`} onClick={() => toggleWeekday(day)}><span>{["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][index]}</span>{selected && <Check aria-hidden="true" />}</button>})}</fieldset>}
            {!["ONCE", "SPECIFIC_DATE"].includes(form.recurrence_type) && <div className="alarm-date-grid"><label className="alarm-field"><span>Start date <em>Optional</em></span><input type="date" min={localDateInput(new Date())} value={form.start_date} onChange={(event) => updateField("start_date", event.target.value)} /></label><label className="alarm-field"><span>End date <em>Optional</em></span><input type="date" min={form.start_date || localDateInput(new Date())} value={form.end_date} onChange={(event) => updateField("end_date", event.target.value)} /></label></div>}
            {calculatedNext && <p className="alarm-next-preview" role="status">Next alarm: {formatAlarmDate(calculatedNext)}</p>}

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
                    <div className="alarm-row-time"><strong>{formatAlarmTime24(alarm.scheduled_at)}</strong><small>{formatAlarmCalendarDate(alarm.scheduled_at)}</small></div>
                    <div className="alarm-row-copy"><span><strong>{alarm.title}</strong><em>{alarm.ai_generated ? "AI personalized" : "Reliable fallback"}</em></span><p>{alarm.assistant_message}</p><small><Mic2 /> {alarm.language.replace("-IN", "")} · {alarm.voice_style} <Volume2 /> {alarm.ringtone} · {alarm.repeat.length ? alarm.repeat.map((day)=>["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][day]).join(", ") : "Once"} · Snooze {alarm.snooze_minutes}m · Vibration {alarm.vibration ? "on" : "off"}</small></div>
                    <div className="alarm-row-controls">
                      <button type="button" className={`alarm-toggle${alarm.enabled ? " is-on" : ""}`} onClick={() => void updateAlarm(alarm.id, { enabled: !alarm.enabled }).catch(() => undefined)} aria-label={`${alarm.enabled ? "Pause" : "Enable"} ${alarm.title}`} aria-pressed={alarm.enabled}><span /></button>
                      <button type="button" onClick={() => void previewAlarm(alarm)} aria-label={`Preview ${alarm.title}`}><Volume2 /></button>
                      <button type="button" onClick={() => edit(alarm)} aria-label={`Edit ${alarm.title}`}><Edit3 /></button>
                      <button type="button" onClick={() => void duplicate(alarm)} aria-label={`Duplicate ${alarm.title}`}><Plus /></button>
                      {alarm.repeat.length > 0 && <button type="button" onClick={() => void skipAlarm(alarm.id)} aria-label={`Skip next occurrence of ${alarm.title}`}><RefreshCw /></button>}
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
