import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileText,
  History,
  Languages,
  LoaderCircle,
  LockKeyhole,
  PlayCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import type { ServiceTaskView } from "../../types";
import { ServiceTaskCard } from "../formService/ServiceTaskCard";
import { SevaAssistancePanel } from "./SevaAssistancePanel";
import { SevaSearchPanel } from "./SevaSearchPanel";
import { sevaApi } from "./sevaApi";
import "./autoaiSeva.css";
import "./sevaAdvanced.css";
import "./autoaiSevaScrollFix.css";

const TERMINAL = new Set(["COMPLETED_VERIFIED", "FAILED_FINAL", "CANCELLED", "EXPIRED"]);

function stateLabel(state: string) {
  return state.toLowerCase().replace(/_/g, " ");
}

function dateLabel(value: string) {
  return new Date(value).toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function applicationStatus(task: ServiceTaskView) {
  if (task.state === "COMPLETED_VERIFIED") return "Completed";
  if (task.state === "SUBMITTED_UNVERIFIED" || task.state === "VERIFYING") return "Submitted";
  if (task.state === "FAILED_FINAL" || task.state === "FAILED_RECOVERABLE") return "Needs attention";
  if (task.state === "CANCELLED" || task.state === "EXPIRED") return stateLabel(task.state);
  return "In progress";
}

function SevaHeader({ title, backTo }: { title: string; backTo?: string }) {
  const navigate = useNavigate();
  return (
    <header className="seva-topbar">
      <div>
        {backTo ? (
          <button type="button" className="seva-icon-button" onClick={() => navigate(backTo)} aria-label="Go back">
            <ArrowLeft size={19} />
          </button>
        ) : null}
        <span className="seva-mark"><FileCheck2 size={21} /></span>
        <span><strong>AutoAI Seva</strong><small>{title}</small></span>
      </div>
      <button type="button" className="seva-history-button" onClick={() => navigate("/seva/applications")}>
        <History size={17} /> Applications
      </button>
    </header>
  );
}

export function AutoAISevaPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState<"real" | "demo" | "">("");
  const [error, setError] = useState("");
  const [applications, setApplications] = useState<ServiceTaskView[]>([]);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void sevaApi.listApplications(token, { pageSize: 8 })
      .then((page) => { if (active) setApplications(page.items); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [token]);

  const activeApplication = useMemo(
    () => applications.find((item) => !TERMINAL.has(item.state)),
    [applications],
  );

  async function begin(mode: "real" | "demo") {
    if (!token || starting) return;
    setStarting(mode);
    setError("");
    try {
      const task = mode === "demo"
        ? await sevaApi.startIncomeCertificateDemo(token)
        : await sevaApi.startIncomeCertificate(token);
      navigate(`/seva/applications/${encodeURIComponent(task.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The application could not be started.");
      setStarting("");
    }
  }

  return (
    <div className="seva-page">
      <SevaHeader title="AI Application Agent" />
      <main className="seva-home">
        {token ? (
          <SevaSearchPanel
            token={token}
            onStarted={(task) => navigate(`/seva/applications/${encodeURIComponent(task.id)}`)}
          />
        ) : null}

        <section className="seva-hero">
          <div className="seva-hero-copy">
            <span className="seva-eyebrow"><Sparkles size={16} /> Secure assisted applications</span>
            <h1>Search, fill and track applications from one workspace.</h1>
            <p>AutoAI opens the correct form, collects required details, checks documents and shows live thinking. If automatic completion is unavailable, a verified employee continues from the saved application after your approval.</p>
            <div className="seva-hero-actions">
              <button type="button" className="seva-primary" disabled={Boolean(starting)} onClick={() => void begin("real")}>
                {starting === "real" ? <LoaderCircle className="spin" size={18} /> : <FileText size={18} />}
                Apply for Income Certificate
              </button>
              <button type="button" className="seva-secondary" disabled={Boolean(starting)} onClick={() => void begin("demo")}>
                {starting === "demo" ? <LoaderCircle className="spin" size={18} /> : <PlayCircle size={18} />}
                Run safe demo
              </button>
            </div>
            {activeApplication ? (
              <button type="button" className="seva-continue" onClick={() => navigate(`/seva/applications/${encodeURIComponent(activeApplication.id)}`)}>
                Continue {activeApplication.service_name}<ArrowRight size={17} />
              </button>
            ) : null}
            {error ? <p className="seva-error" role="alert">{error}</p> : null}
          </div>
          <div className="seva-hero-visual" aria-label="Application workflow preview">
            <span className="seva-orbit seva-orbit-one" />
            <span className="seva-orbit seva-orbit-two" />
            <div className="seva-visual-card">
              <header><BadgeCheck size={20} /><span><strong>AutoAI Seva Workflow</strong><small>AI first · Employee fallback</small></span></header>
              <div className="seva-progress"><span style={{ width: "68%" }} /></div>
              <ul>
                <li className="done"><CheckCircle2 size={16} /> Service identified</li>
                <li className="done"><CheckCircle2 size={16} /> Form and documents saved</li>
                <li className="active"><Clock3 size={16} /> Submission or employee assistance</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="seva-trust-strip">
          <article><ShieldCheck /><span><strong>Verified destination</strong><small>Only approved HTTPS portal origins</small></span></article>
          <article><LockKeyhole /><span><strong>Protected secrets</strong><small>OTP, CAPTCHA and passwords are never shared with employees</small></span></article>
          <article><Languages /><span><strong>Hindi friendly</strong><small>Hindi, Hinglish and English requests</small></span></article>
        </section>

        <section className="seva-flow-section">
          <div className="seva-section-heading"><span>How it works</span><h2>AI handles preparation. You remain active and in control.</h2></div>
          <div className="seva-flow-grid">
            {[
              ["01", "Search the service", "Describe what you need. AutoAI matches a verified service or opens an assisted request."],
              ["02", "Fill the exact form", "Complete dynamic fields and upload only the documents required for that application."],
              ["03", "Watch live progress", "Thinking stages, validation, OCR review and saved progress remain visible."],
              ["04", "AI or employee continues", "Automatic adapters proceed safely; otherwise a verified employee receives scoped access."],
              ["05", "Receive proof", "Download the final application PDF or receipt and track the status."],
            ].map(([number, title, description]) => (
              <article key={number}><span>{number}</span><h3>{title}</h3><p>{description}</p></article>
            ))}
          </div>
        </section>

        <section className="seva-mode-grid">
          <article className="seva-mode-card official">
            <span><ExternalLink size={18} /> Official assisted mode</span>
            <h2>Real Bihar application</h2>
            <p>Prepares your application and opens only the verified government portal. OTP, CAPTCHA, declarations and final submit stay under your control.</p>
            <button type="button" onClick={() => void begin("real")} disabled={Boolean(starting)}>Start official flow<ArrowRight size={17} /></button>
          </article>
          <article className="seva-mode-card demo">
            <span><ClipboardCheck size={18} /> Safe demonstration</span>
            <h2>Test the complete experience</h2>
            <p>Uses a local mock service with Bihar-style fields. It can finish with a verified demo receipt without sending data to a government portal.</p>
            <button type="button" onClick={() => void begin("demo")} disabled={Boolean(starting)}>Run demo<PlayCircle size={17} /></button>
          </article>
        </section>
      </main>
    </div>
  );
}

export function SevaApplicationsPage() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<ServiceTaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const page = await sevaApi.listApplications(token, { pageSize: 100 });
      setItems(page.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Applications could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="seva-page">
      <SevaHeader title="My applications" backTo="/seva" />
      <main className="seva-applications">
        <section className="seva-list-heading">
          <div><span>Application history</span><h1>Continue, review or track your work.</h1></div>
          <button type="button" className="seva-secondary" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={17} /> Refresh</button>
        </section>
        {loading ? <div className="seva-empty"><LoaderCircle className="spin" /><p>Loading applications…</p></div> : null}
        {!loading && error ? <div className="seva-empty error"><p>{error}</p><button type="button" onClick={() => void load()}>Retry</button></div> : null}
        {!loading && !error && !items.length ? <div className="seva-empty"><FileCheck2 /><h2>No applications yet</h2><p>Search for the service you want to apply for.</p><button type="button" onClick={() => navigate("/seva")}>Start application</button></div> : null}
        <div className="seva-application-list">
          {items.map((item) => (
            <button type="button" key={item.id} className="seva-application-row" onClick={() => navigate(`/seva/applications/${encodeURIComponent(item.id)}`)}>
              <span className="seva-row-icon"><FileText size={19} /></span>
              <span className="seva-row-copy"><strong>{item.service_name}</strong><small>{item.provider} · Updated {dateLabel(item.updated_at)}</small></span>
              <span className={`seva-status seva-status-${applicationStatus(item).toLowerCase().replace(/\s+/g, "-")}`}>{applicationStatus(item)}</span>
              <span className="seva-row-progress"><i style={{ width: `${Math.max(2, item.progress_percent)}%` }} /><small>{item.progress_percent}%</small></span>
              <ArrowRight size={18} />
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}

export function SevaApplicationPage() {
  const { token } = useAuth();
  const { applicationId = "" } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<ServiceTaskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!token || !applicationId) return;
    if (!silent) setLoading(true);
    setError("");
    try {
      setTask(await sevaApi.getApplication(token, applicationId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Application could not be loaded.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applicationId, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load(true);
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <div className="seva-page seva-workspace-page">
      <SevaHeader title={task?.service_name || "Application workspace"} backTo="/seva/applications" />
      <main className="seva-workspace">
        {loading ? <div className="seva-empty"><LoaderCircle className="spin" /><p>Opening secure workspace…</p></div> : null}
        {!loading && error ? <div className="seva-empty error"><p>{error}</p><div><button type="button" onClick={() => void load()}>Retry</button><button type="button" onClick={() => navigate("/seva")}>Back to Seva</button></div></div> : null}
        {!loading && task ? (
          <>
            <section className="seva-workspace-summary">
              <div><span>{task.provider}</span><h1>{task.service_name}</h1><p>{stateLabel(task.state)} · {task.progress_percent}% complete</p></div>
              <div className="seva-workspace-progress"><span style={{ width: `${task.progress_percent}%` }} /></div>
              <button type="button" className="seva-icon-button" onClick={() => void load(true)} aria-label="Refresh application"><RefreshCw size={18} /></button>
            </section>
            <aside className="seva-official-note">
              <ShieldCheck size={19} />
              <span><strong>Protected actions remain yours.</strong><small>AutoAI and employees never store your OTP, CAPTCHA or password. Review every field before final confirmation.</small></span>
            </aside>
            <section className="seva-task-shell">
              <ServiceTaskCard key={`${task.id}-${task.version}-${task.updated_at}`} task={task} token={token} />
            </section>
            {token ? <SevaAssistancePanel token={token} taskId={task.id} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
