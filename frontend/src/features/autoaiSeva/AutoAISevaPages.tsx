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
import { sevaApi } from "./sevaApi";
import "./autoaiSeva.css";

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
        <section className="seva-hero">
          <div className="seva-hero-copy">
            <span className="seva-eyebrow"><Sparkles size={16} /> Secure assisted applications</span>
            <h1>Income Certificate application—prepared step by step.</h1>
            <p>AutoAI collects information, checks documents, prepares the final review and guides you through the verified Bihar portal.</p>
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
              <header><BadgeCheck size={20} /><span><strong>Bihar Income Certificate</strong><small>Block level · Assisted mode</small></span></header>
              <div className="seva-progress"><span style={{ width: "68%" }} /></div>
              <ul>
                <li className="done"><CheckCircle2 size={16} /> Information collected</li>
                <li className="done"><CheckCircle2 size={16} /> Documents checked</li>
                <li className="active"><Clock3 size={16} /> Final portal step</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="seva-trust-strip">
          <article><ShieldCheck /><span><strong>Verified destination</strong><small>Only approved HTTPS portal origins</small></span></article>
          <article><LockKeyhole /><span><strong>Private by design</strong><small>OTP and CAPTCHA are never stored</small></span></article>
          <article><Languages /><span><strong>Hindi friendly</strong><small>Hindi, Hinglish and English requests</small></span></article>
        </section>

        <section className="seva-flow-section">
          <div className="seva-section-heading"><span>How it works</span><h2>AI handles preparation. You control protected actions.</h2></div>
          <div className="seva-flow-grid">
            {[
              ["01", "Tell AutoAI", "Say or tap that you need a Bihar Income Certificate."],
              ["02", "Provide details", "Complete the dynamic form and upload only requested documents."],
              ["03", "Review safely", "Check extracted values, resolve warnings and approve the final preview."],
              ["04", "Complete portal step", "Enter OTP/CAPTCHA yourself and confirm final submission on the official portal."],
              ["05", "Track result", "Save the reference, receipt and current application status."],
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
        {!loading && !error && !items.length ? <div className="seva-empty"><FileCheck2 /><h2>No applications yet</h2><p>Start with the Bihar Income Certificate workflow.</p><button type="button" onClick={() => navigate("/seva")}>Start application</button></div> : null}
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
              <span><strong>Protected actions remain yours.</strong><small>AutoAI never stores your OTP or CAPTCHA. Review every field before final confirmation.</small></span>
            </aside>
            <section className="seva-task-shell">
              <ServiceTaskCard key={`${task.id}-${task.version}-${task.updated_at}`} task={task} token={token} />
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
