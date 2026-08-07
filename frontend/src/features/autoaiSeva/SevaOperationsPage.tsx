import { CheckCircle2, Download, FileCheck2, FileText, LoaderCircle, RefreshCw, Send, ShieldCheck, Upload, UserCheck, UsersRound } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { sevaApi, type SevaWorkOrder } from "./sevaApi";
import { sevaScopeApi, type SevaApprovedScope } from "./sevaScopeApi";
import "./autoaiSeva.css";
import "./sevaAdvanced.css";
import "./autoaiSevaScrollFix.css";

const STATUS_OPTIONS: Array<SevaWorkOrder["status"]> = ["IN_PROGRESS", "WAITING_USER", "SUBMITTED", "COMPLETED"];

function readable(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function printableValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SevaOperationsPage() {
  const { token, user } = useAuth();
  const [items, setItems] = useState<SevaWorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<SevaWorkOrder | null>(null);
  const [scope, setScope] = useState<SevaApprovedScope | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"TEXT" | "DOCUMENT" | "PROTECTED_ACTION">("TEXT");
  const [label, setLabel] = useState("");
  const [instructions, setInstructions] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [deliverableLabel, setDeliverableLabel] = useState("Application receipt PDF");
  const [deliverableNote, setDeliverableNote] = useState("");
  const [deliverableFile, setDeliverableFile] = useState<File | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const result = await sevaApi.listWorkOrders(token);
      setItems(result.items);
      setSelectedId((current) => current || result.items[0]?.id || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Seva work orders could not be loaded.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [token]);

  const loadSelected = useCallback(async () => {
    if (!token || !selectedId) {
      setSelected(null);
      setScope(null);
      return;
    }
    try {
      const next = await sevaApi.getWorkOrder(token, selectedId);
      setSelected(next);
      if (next.assigned_employee?.id === user?.id && next.status !== "CANCELLED") {
        setScope(await sevaScopeApi.get(token, next.id));
      } else {
        setScope(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Work order could not be opened.");
    }
  }, [selectedId, token, user?.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSelected(); }, [loadSelected]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(true); void loadSelected(); }, 12_000);
    return () => window.clearInterval(timer);
  }, [load, loadSelected]);

  const pendingRequirements = useMemo(
    () => selected?.requirements.filter((item) => item.status === "FULFILLED").length ?? 0,
    [selected],
  );

  async function run(key: string, action: () => Promise<SevaWorkOrder>) {
    if (working) return;
    setWorking(key);
    setError("");
    try {
      const next = await action();
      setSelected(next);
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
      if (token && next.assigned_employee?.id === user?.id && next.status !== "CANCELLED") {
        setScope(await sevaScopeApi.get(token, next.id));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally {
      setWorking("");
    }
  }

  async function createRequirement(event: FormEvent) {
    event.preventDefault();
    if (!token || !selected || !label.trim()) return;
    await run("requirement", () => sevaApi.createRequirement(token, selected.id, {
      kind,
      label: label.trim(),
      instructions: instructions.trim(),
      required: true,
    }));
    setLabel("");
    setInstructions("");
  }

  async function uploadDeliverable(event: FormEvent) {
    event.preventDefault();
    if (!token || !selected || !deliverableFile) return;
    await run("deliverable", () => sevaApi.uploadDeliverable(token, selected.id, deliverableFile, deliverableLabel, deliverableNote, true));
    setDeliverableFile(null);
    setDeliverableNote("");
  }

  async function downloadApprovedDocument(assetId: string, filename: string) {
    if (!token || !selected || working) return;
    setWorking(`scope-${assetId}`);
    setError("");
    try {
      const blob = await sevaScopeApi.downloadDocument(token, selected.id, assetId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approved document could not be downloaded.");
    } finally {
      setWorking("");
    }
  }

  return (
    <div className="seva-page">
      <header className="seva-topbar">
        <div><span className="seva-mark"><UsersRound size={21} /></span><span><strong>AutoAI Seva Operations</strong><small>Employee application queue</small></span></div>
        <button type="button" className="seva-history-button" onClick={() => void load()}><RefreshCw className={loading ? "spin" : ""} size={17} /> Refresh</button>
      </header>
      <main className="seva-employee-page">
        <section className="seva-list-heading"><div><span>Operations workspace</span><h1>Claim requests, ask requirements and deliver final PDFs.</h1></div></section>
        {error ? <p className="seva-error" role="alert">{error}</p> : null}
        <div className="seva-employee-layout">
          <aside className="seva-work-order-list">
            {loading ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Loading queue…</div> : null}
            {!loading && !items.length ? <div className="seva-empty"><FileCheck2 /><p>No employee requests are waiting.</p></div> : null}
            {items.map((item) => (
              <button key={item.id} type="button" className={selectedId === item.id ? "active" : ""} onClick={() => setSelectedId(item.id)}>
                <strong>{item.service?.name || "AutoAI Seva request"}</strong>
                <small>{item.owner?.name || "User"} · {readable(item.status)}</small>
                <span>{item.request_summary}</span>
              </button>
            ))}
          </aside>

          <section className="seva-work-order-detail">
            {!selected ? <div className="seva-empty"><UsersRound /><p>Select a work order.</p></div> : (
              <>
                <header className="seva-workspace-summary">
                  <div><span>{selected.owner?.name} · {selected.owner?.email}</span><h1>{selected.service?.name || "Assisted request"}</h1><p>{readable(selected.status)} · task {selected.task_progress}%</p></div>
                  <div className="seva-workspace-progress"><span style={{ width: `${selected.task_progress}%` }} /></div>
                </header>
                <p className="seva-employee-note"><ShieldCheck size={16} />Only user-approved fields and documents are available. Never request a raw OTP, CAPTCHA, password or payment secret.</p>
                <div className="seva-employee-toolbar">
                  {!selected.assigned_employee ? <button type="button" disabled={Boolean(working)} onClick={() => token && void run("claim", () => sevaApi.claimWorkOrder(token, selected.id))}><UserCheck size={16} /> Claim request</button> : <span>Assigned to <strong>{selected.assigned_employee.name}</strong></span>}
                  {STATUS_OPTIONS.map((item) => <button key={item} type="button" disabled={Boolean(working)} onClick={() => token && void run(item, () => sevaApi.updateWorkOrderStatus(token, selected.id, item, statusNote))}>{readable(item)}</button>)}
                </div>
                <textarea value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder="Status note visible to the user" rows={2} />

                {scope ? (
                  <section className="seva-approved-scope">
                    <header><span><ShieldCheck size={18} /><strong>User-approved application data</strong></span><small>Authentication secrets shared: no</small></header>
                    <div className="seva-approved-fields">
                      {scope.fields.length ? scope.fields.map((field) => (
                        <article key={field.key}><small>{field.label}</small><strong>{printableValue(field.value)}</strong><span>{field.source}{field.verified ? " · verified" : ""}</span></article>
                      )) : <p>No completed field values were approved yet.</p>}
                    </div>
                    <div className="seva-approved-documents">
                      {scope.documents.map((document) => (
                        <article key={document.asset_id}><span><FileText size={17} /><span><strong>{document.filename}</strong><small>{document.content_type} · {document.validation_status.toLowerCase()}</small></span></span><button type="button" disabled={working === `scope-${document.asset_id}`} onClick={() => void downloadApprovedDocument(document.asset_id, document.filename)}>{working === `scope-${document.asset_id}` ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Download</button></article>
                      ))}
                    </div>
                  </section>
                ) : selected.assigned_employee?.id === user?.id ? <div className="seva-assistance-loading"><LoaderCircle className="spin" /> Loading user-approved scope…</div> : null}

                <form className="seva-requirement-builder" onSubmit={createRequirement}>
                  <h3>Ask the user for a requirement</h3>
                  <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                    <option value="TEXT">Non-secret information</option>
                    <option value="DOCUMENT">Document upload</option>
                    <option value="PROTECTED_ACTION">Protected action (OTP/CAPTCHA/final submit)</option>
                  </select>
                  <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={kind === "PROTECTED_ACTION" ? "Complete OTP on the official portal" : "Requirement title"} maxLength={180} required />
                  <textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Clear instructions for the user" rows={3} maxLength={1000} />
                  <button type="submit" className="seva-primary" disabled={working === "requirement" || selected.assigned_employee?.id !== user?.id}>{working === "requirement" ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />} Send requirement</button>
                </form>

                <div className="seva-requirements-list">
                  <h3>User requirements {pendingRequirements ? `· ${pendingRequirements} ready for review` : ""}</h3>
                  {selected.requirements.map((requirement) => (
                    <article key={requirement.id} className={`seva-employee-requirement status-${requirement.status.toLowerCase()}`}>
                      <header><span><FileText size={17} /><strong>{requirement.label}</strong></span><b>{readable(requirement.status)}</b></header>
                      <p>{requirement.instructions}</p>
                      {requirement.response_text ? <p><CheckCircle2 size={15} /> {requirement.response_text}</p> : null}
                      {requirement.response_document ? <p><FileText size={15} /> {requirement.response_document.filename}</p> : null}
                      {requirement.status === "FULFILLED" ? <div className="seva-employee-toolbar"><button type="button" onClick={() => token && void run(`accept-${requirement.id}`, () => sevaApi.reviewRequirement(token, selected.id, requirement.id, true))}>Accept</button><button type="button" onClick={() => token && void run(`reject-${requirement.id}`, () => sevaApi.reviewRequirement(token, selected.id, requirement.id, false, "Please provide a clearer or valid response."))}>Request again</button></div> : null}
                    </article>
                  ))}
                </div>

                <form className="seva-final-upload" onSubmit={uploadDeliverable}>
                  <h3>Attach final application or receipt</h3>
                  <input value={deliverableLabel} onChange={(event) => setDeliverableLabel(event.target.value)} maxLength={180} />
                  <textarea value={deliverableNote} onChange={(event) => setDeliverableNote(event.target.value)} placeholder="Application number, submission note or next step" rows={3} />
                  <label className="seva-employee-upload"><Upload size={17} />{deliverableFile?.name || "Select final PDF/image"}<input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => setDeliverableFile(event.target.files?.[0] || null)} /></label>
                  <button type="submit" className="seva-primary" disabled={!deliverableFile || working === "deliverable" || selected.assigned_employee?.id !== user?.id}>{working === "deliverable" ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} Upload and complete</button>
                </form>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
