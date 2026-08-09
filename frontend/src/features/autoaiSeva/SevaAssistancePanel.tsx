import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Send,
  ShieldCheck,
  Upload,
  UserCheck,
  UsersRound,
  XCircle,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sevaApi, type SevaNotification, type SevaRequirement, type SevaWorkOrder } from "./sevaApi";

const CLOSED = new Set(["COMPLETED", "CANCELLED"]);

function readableStatus(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function requirementIcon(requirement: SevaRequirement) {
  if (requirement.kind === "DOCUMENT") return <FileText size={18} />;
  if (requirement.kind === "PROTECTED_ACTION") return <LockKeyhole size={18} />;
  return <Send size={18} />;
}

export function SevaAssistancePanel({ token, taskId, autoAssign = false }: { token: string; taskId: string; autoAssign?: boolean }) {
  const [workOrder, setWorkOrder] = useState<SevaWorkOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const assignmentRequested = useRef(false);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notifications, setNotifications] = useState<SevaNotification[]>([]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await sevaApi.getAssistance(token, taskId);
      let nextWorkOrder = result.work_order;
      if (!nextWorkOrder && autoAssign && !assignmentRequested.current) {
        assignmentRequested.current = true;
        setWorking("request");
        nextWorkOrder = await sevaApi.requestAssistance(token, taskId, "Process this submitted application and provide the final acknowledgement or receipt.");
      }
      setWorkOrder(nextWorkOrder);
      const alerts = await sevaApi.listNotifications(token);
      setNotifications(alerts.items.filter((item) => !item.read_at && (!nextWorkOrder || item.work_order_id === nextWorkOrder.id)));
      setError("");
    } catch (reason) {
      if (autoAssign) assignmentRequested.current = false;
      if (!silent) setError(reason instanceof Error ? reason.message : "Agent processing status could not be loaded.");
    } finally {
      setWorking((current) => current === "request" ? "" : current);
      if (!silent) setLoading(false);
    }
  }, [autoAssign, taskId, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!workOrder || CLOSED.has(workOrder.status)) return;
    const timer = window.setInterval(() => void load(true), 10_000);
    return () => window.clearInterval(timer);
  }, [load, workOrder]);

  const pendingCount = useMemo(
    () => workOrder?.requirements.filter((item) => item.status === "REQUESTED").length ?? 0,
    [workOrder],
  );

  async function submitText(event: FormEvent, requirement: SevaRequirement) {
    event.preventDefault();
    const value = (responses[requirement.id] || "").trim();
    if (!value || working) return;
    setWorking(requirement.id);
    setError("");
    try {
      setWorkOrder(await sevaApi.respondRequirementText(token, taskId, requirement.id, value, notes[requirement.id] || ""));
      setResponses((current) => ({ ...current, [requirement.id]: "" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The response could not be sent.");
    } finally {
      setWorking("");
    }
  }

  async function uploadDocument(requirement: SevaRequirement, file?: File) {
    if (!file || working) return;
    setWorking(requirement.id);
    setError("");
    try {
      setWorkOrder(await sevaApi.respondRequirementDocument(token, taskId, requirement.id, file, notes[requirement.id] || ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The document could not be uploaded.");
    } finally {
      setWorking("");
    }
  }

  async function completeProtected(requirement: SevaRequirement) {
    if (working) return;
    setWorking(requirement.id);
    setError("");
    try {
      setWorkOrder(await sevaApi.completeProtectedAction(token, taskId, requirement.id, notes[requirement.id] || ""));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The protected action could not be confirmed.");
    } finally {
      setWorking("");
    }
  }

  async function download(deliverableId: string, filename: string) {
    setWorking(deliverableId);
    setError("");
    try {
      const blob = await sevaApi.downloadDeliverable(token, deliverableId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || "autoai-seva-receipt.pdf";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The PDF could not be downloaded.");
    } finally {
      setWorking("");
    }
  }

  async function cancel() {
    if (!workOrder || working) return;
    setWorking("cancel");
    try {
      setWorkOrder(await sevaApi.cancelAssistance(token, taskId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Assistance could not be cancelled.");
    } finally {
      setWorking("");
    }
  }

  return (
    <section className="seva-assistance-panel" aria-label="AutoAI agent processing">
      <header>
        <span className="seva-assistance-icon"><UsersRound size={21} /></span>
        <span><strong>Application Processing</strong><small>Verified agent assignment • live status • protected access</small></span>
        {workOrder ? <b className={`seva-work-status status-${workOrder.status.toLowerCase()}`}>{readableStatus(workOrder.status)}</b> : null}
      </header>

      {loading ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Loading assistance status…</div> : null}
      {!loading && !workOrder && autoAssign ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Sending the submitted application to the agent queue…</div> : null}

      {workOrder ? (
        <div className="seva-assistance-body">
          <div className="seva-assistance-overview">
            <article><FileText size={17} /><span><small>Case ID</small><strong>{workOrder.case_id}</strong></span></article>
            <article><Clock3 size={17} /><span><small>Current work · {workOrder.work_progress}%</small><strong>{workOrder.current_activity}</strong></span></article>
            <article><UserCheck size={17} /><span><small>Assigned agent</small><strong>{workOrder.assigned_employee?.name || (workOrder.queue_position ? `Queue #${workOrder.queue_position}` : "Waiting for assignment")}</strong></span></article>
            <article><AlertTriangle size={17} /><span><small>User actions pending</small><strong>{pendingCount}</strong></span></article>
          </div>
          {workOrder.reference_number ? <p className="seva-employee-note"><FileText size={16} />Reference: {workOrder.reference_number}</p> : null}
          {notifications.length ? <div className="seva-requirements-list" aria-live="polite"><h3>New updates</h3>{notifications.map((item) => <article key={item.id} className="seva-employee-requirement"><header><strong>{item.title}</strong><button type="button" onClick={() => void sevaApi.markNotificationRead(token, item.id).then(() => setNotifications((current) => current.filter((notice) => notice.id !== item.id)))}>Mark read</button></header><p>{item.message}</p></article>)}</div> : null}

          {workOrder.employee_note ? <p className="seva-employee-note"><UsersRound size={16} />{workOrder.employee_note}</p> : null}

          {workOrder.status === "QUEUED" || workOrder.status === "IN_PROGRESS" ? (
            <div className="seva-live-working" aria-live="polite"><LoaderCircle className="spin" /><span><strong>{workOrder.status === "QUEUED" ? "Finding the right agent" : "Agent is working on the application"}</strong><small>Your saved progress remains active. Refresh is automatic.</small></span></div>
          ) : null}

          {workOrder.requirements.length ? (
            <div className="seva-requirements-list">
              <h3>Agent requirements</h3>
              {workOrder.requirements.map((requirement) => (
                <article key={requirement.id} className={`seva-employee-requirement status-${requirement.status.toLowerCase()}`}>
                  <header><span>{requirementIcon(requirement)}<strong>{requirement.label}</strong></span><b>{readableStatus(requirement.status)}</b></header>
                  {requirement.instructions ? <p>{requirement.instructions}</p> : null}
                  {requirement.kind === "PROTECTED_ACTION" ? <div className="seva-protected-warning"><ShieldCheck size={16} />Complete OTP, CAPTCHA, password or final confirmation directly on the official portal. Do not send the raw secret to an agent.</div> : null}
                  {requirement.status === "REQUESTED" && requirement.kind === "TEXT" ? (
                    <form onSubmit={(event) => void submitText(event, requirement)}>
                      <textarea value={responses[requirement.id] || ""} onChange={(event) => setResponses((current) => ({ ...current, [requirement.id]: event.target.value }))} rows={3} maxLength={2000} placeholder="Enter the requested non-secret information" required />
                      <button type="submit" disabled={working === requirement.id}>{working === requirement.id ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} Send securely</button>
                    </form>
                  ) : null}
                  {requirement.status === "REQUESTED" && requirement.kind === "DOCUMENT" ? (
                    <label className="seva-employee-upload"><Upload size={17} />{working === requirement.id ? "Uploading…" : "Upload PDF or image"}<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => void uploadDocument(requirement, event.target.files?.[0])} /></label>
                  ) : null}
                  {requirement.status === "REQUESTED" && requirement.kind === "PROTECTED_ACTION" ? (
                    <button type="button" className="seva-protected-complete" disabled={working === requirement.id} onClick={() => void completeProtected(requirement)}>{working === requirement.id ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />} I completed this protected step</button>
                  ) : null}
                  {requirement.response_document ? <p className="seva-requirement-response"><FileText size={15} />{requirement.response_document.filename}</p> : null}
                  {requirement.response_text ? <p className="seva-requirement-response"><CheckCircle2 size={15} />Response sent</p> : null}
                </article>
              ))}
            </div>
          ) : null}

          {workOrder.deliverables.length ? (
            <div className="seva-deliverables">
              <h3>Application PDFs and receipts</h3>
              {workOrder.deliverables.map((item) => (
                <article key={item.id}>
                  <span><FileText size={20} /><span><strong>{item.label}</strong><small>{item.note || item.document?.filename || "Agent deliverable"}</small></span></span>
                  <button type="button" disabled={working === item.id} onClick={() => void download(item.id, item.document?.filename || `${item.label}.pdf`)}>{working === item.id ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />} Download</button>
                </article>
              ))}
            </div>
          ) : null}

          {workOrder.timeline.length ? <div className="seva-case-timeline"><h3>Application timeline</h3>{workOrder.timeline.map((event) => <article key={event.id}><span /><div><strong>{event.title}</strong><small>{new Date(event.created_at).toLocaleString()}</small></div></article>)}</div> : null}

          {!CLOSED.has(workOrder.status) ? <button type="button" className="seva-cancel-assistance" disabled={Boolean(working)} onClick={() => void cancel()}><XCircle size={16} /> Revoke agent access</button> : null}
          {workOrder.status === "CANCELLED" ? <p className="seva-revoked-note"><ShieldCheck size={16} />Agent access was revoked.</p> : null}
        </div>
      ) : null}
      {error ? <p className="seva-error" role="alert">{error} <button type="button" onClick={() => void load()}>Retry</button></p> : null}
    </section>
  );
}
