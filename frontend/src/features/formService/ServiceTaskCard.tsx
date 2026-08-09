import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  Printer,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Upload,
  XCircle
} from "lucide-react";

import { api, streamServiceTaskEvents, type ServiceTaskEvent } from "../../api/client";
import type { LibraryAsset, ServiceFieldDefinition, ServiceTaskView } from "../../types";
import { serviceNative, type NativePermissionStatus } from "./serviceNative";
import "./serviceTaskCard.css";
import "./serviceTaskCardEnhancements.css";

type Props = { task: ServiceTaskView; token?: string | null };
type CardStatus = "idle" | "working" | "success" | "error";
type DocumentRequirementView = { id: string; key: string; label: string; accepted_mime_types: string[]; max_bytes: number; required: boolean; status: string };
type ExtractedDocumentField = { label: string; value: string; confidence: number; source: string; accepted?: boolean };
type DocumentView = { id: string; requirement_id: string; label: string; filename: string; content_type: string; file_size: number; validation_status: string; detected_type?: string | null; warnings?: string[]; preview_url?: string; analysis_status?: string; ocr_status?: string; extracted_fields?: Record<string, ExtractedDocumentField>; page_count?: number | null; image_dimensions?: { width?: number; height?: number } };
type ShareableField = { key: string; label: string };
type ActiveHandoff = { id: string; purpose: string; approved_field_keys: string[]; approved_document_ids: string[]; agent_identity: { status?: string; verified?: boolean }; expires_at: string };
type WorkflowSummary = { workflow_id?: string; current_step?: number; total_steps?: number; progress_percent?: number; current_operation?: string; completed_steps?: string[] };
type ApplicationPreviewData = { portal_name?: string; official_origin?: string | null; current_stage?: string; completed_fields?: number; total_fields?: number; completed_documents?: number; total_documents?: number; currently_filling?: string; fields?: Array<{ key: string; label: string; value: unknown; source: string; status: string; confidence: string }>; documents?: Array<{ label: string; filename: string; status: string; warnings?: string[] }>; submission_ready?: boolean };

function dataValue<T>(task: ServiceTaskView, key: string, fallback: T): T {
  const value = task.active_card.data[key];
  return (value === undefined || value === null ? fallback : value) as T;
}

function readableBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function stateLabel(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function printableValue(key: string, value: unknown) {
  const text = String(value ?? "Not provided");
  if (/password|passcode|otp|pin|secret|cvv|recovery[_ -]?code/i.test(key)) return "[Excluded from printable copy]";
  if (/aadha?ar|identity[_ -]?number|account[_ -]?number|card[_ -]?number|pan[_ -]?number/i.test(key)) {
    const visible = text.slice(-4);
    return visible ? `${"•".repeat(Math.min(8, Math.max(4, text.length - 4)))}${visible}` : "[Masked]";
  }
  return text;
}

function printableApplicationHtml(task: ServiceTaskView) {
  const data = task.active_card.data;
  const preview = dataValue<ApplicationPreviewData>(task, "application_preview", {});
  const fields = preview.fields || [];
  const documents = preview.documents || [];
  const evidence = Array.isArray(data.evidence) ? data.evidence as Array<Record<string, unknown>> : [];
  const status = String(data.status || stateLabel(task.state));
  const verified = task.state === "COMPLETED_VERIFIED";
  const submitted = data.submission_timestamp ? new Date(String(data.submission_timestamp)).toLocaleString() : "Not verified";
  const fieldRows = fields.length
    ? fields.map((field) => `<tr><th>${escapeHtml(field.label)}</th><td>${escapeHtml(printableValue(field.key, field.value))}</td><td>${escapeHtml(field.status)}</td></tr>`).join("")
    : `<tr><td colspan="3">No printable field preview is available.</td></tr>`;
  const documentRows = documents.length
    ? documents.map((document) => `<tr><th>${escapeHtml(document.label)}</th><td>${escapeHtml(document.filename)}</td><td>${escapeHtml(document.status)}</td></tr>`).join("")
    : `<tr><td colspan="3">No uploaded documents are listed.</td></tr>`;
  const evidenceRows = evidence.length
    ? evidence.map((item) => `<li>${escapeHtml(item.type)} — ${item.verified ? "Verified" : "Unverified"}</li>`).join("")
    : `<li>No independent evidence is available.</li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(task.service_name)} application</title><style>@page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111827;margin:0;font-size:12px;line-height:1.45}.header{border-bottom:2px solid #111827;padding-bottom:12px;margin-bottom:16px}.brand{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#475569}.title{font-size:22px;margin:4px 0}.status{display:inline-block;padding:5px 10px;border-radius:999px;border:1px solid ${verified ? "#15803d" : "#b45309"};color:${verified ? "#166534" : "#92400e"};font-weight:700}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.item{border:1px solid #cbd5e1;border-radius:8px;padding:9px}.item small{display:block;color:#64748b}.section{margin-top:18px}.section h2{font-size:15px;margin:0 0 8px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:7px;text-align:left;vertical-align:top}th{width:34%;background:#f8fafc}ul{margin:0;padding-left:20px}.notice{margin-top:18px;padding:10px;border:1px solid #cbd5e1;background:#f8fafc}.footer{margin-top:24px;padding-top:10px;border-top:1px solid #cbd5e1;color:#64748b;font-size:10px}@media print{button{display:none}}</style></head><body><header class="header"><div class="brand">AutoAI application summary</div><h1 class="title">${escapeHtml(task.service_name)}</h1><div>${escapeHtml(task.provider)}</div><p class="status">${verified ? "VERIFIED COMPLETION" : "UNVERIFIED / IN PROGRESS"} — ${escapeHtml(status)}</p></header><section class="grid"><div class="item"><small>Application ID</small><strong>${escapeHtml(data.application_id || "Not provided")}</strong></div><div class="item"><small>Transaction ID</small><strong>${escapeHtml(data.transaction_id || "Not provided")}</strong></div><div class="item"><small>Official portal</small><strong>${escapeHtml(data.verified_portal || preview.official_origin || "Not available")}</strong></div><div class="item"><small>Submitted</small><strong>${escapeHtml(submitted)}</strong></div></section><section class="section"><h2>Application information</h2><table><tbody>${fieldRows}</tbody></table></section><section class="section"><h2>Documents</h2><table><tbody>${documentRows}</tbody></table></section><section class="section"><h2>Verification evidence</h2><ul>${evidenceRows}</ul></section><div class="notice"><strong>Privacy:</strong> Passwords, OTPs, PINs and authentication secrets are never included. Sensitive identity numbers are masked. This printable summary does not replace an official portal receipt unless the status and evidence above are verified.</div><footer class="footer">Workflow ID: ${escapeHtml(task.id)} · Generated ${escapeHtml(new Date().toLocaleString())}</footer></body></html>`;
}

function downloadPrintableApplication(task: ServiceTaskView) {
  const html = printableApplicationHtml(task);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${task.service_name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100) || "AutoAI-Application"}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FieldControl({ field, value, onChange }: { field: ServiceFieldDefinition; value: unknown; onChange: (value: unknown) => void }) {
  const common = {
    id: `service-field-${field.key}`,
    name: field.key,
    required: Boolean(field.required),
    "aria-describedby": field.explanation ? `service-help-${field.key}` : undefined,
    className: "service-field-control"
  };
  if (field.type === "textarea" || field.type === "address") {
    return <textarea {...common} rows={3} value={String(value ?? "")} minLength={field.min_length} maxLength={field.max_length} onChange={(event) => onChange(event.target.value)} />;
  }
  if (field.type === "select" || field.type === "radio") {
    return (
      <select {...common} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select an option</option>
        {(field.options || []).map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="service-choice-list" aria-label={field.label}>
        {(field.options || []).map((option) => (
          <label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={(event) => onChange(event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))} /> <span>{option}</span></label>
        ))}
      </fieldset>
    );
  }
  if (field.type === "checkbox") {
    return <label className="service-check"><input {...common} type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} /><span>I confirm</span></label>;
  }
  const inputType = field.type === "phone" ? "tel" : field.type;
  return <input {...common} type={inputType} value={String(value ?? "")} min={field.min} max={field.max} minLength={field.min_length} maxLength={field.max_length} pattern={field.pattern} inputMode={field.type === "number" || field.type === "phone" ? "numeric" : undefined} onChange={(event) => onChange(field.type === "number" ? event.target.valueAsNumber : event.target.value)} />;
}

const RTPS_FORM_SECTIONS = [
  { key: "service", title: "आवेदन का विवरण / Application Details" },
  { key: "applicant", title: "आवेदक का विवरण / Applicant Details" },
  { key: "address", title: "पता एवं क्षेत्र का विवरण / Address & Jurisdiction" },
  { key: "other", title: "अन्य जानकारी / Additional Information" },
] as const;

function rtpsSectionForField(field: ServiceFieldDefinition) {
  const key = field.key.toLowerCase();
  if (/service|certificate|scheme|purpose|category/.test(key)) return "service";
  if (/state|district|block|address|village|ward|pin|panchayat|jurisdiction/.test(key)) return "address";
  if (/name|father|mother|dob|birth|gender|mobile|phone|email|occupation/.test(key)) return "applicant";
  return "other";
}

function InformationCard({ task, onSubmit, working }: { task: ServiceTaskView; working: boolean; onSubmit: (requestId: string, values: Record<string, unknown>) => Promise<void> }) {
  const fields = dataValue<ServiceFieldDefinition[]>(task, "fields", []);
  const saved = dataValue<Record<string, unknown>>(task, "saved_values", {});
  const requestId = dataValue<string>(task, "data_request_id", "");
  const storageKey = `autoai:service-draft:${task.id}:${requestId}`;
  const requiresAgentAuthorization = task.execution_mode === "ASSIST";
  const [agentAuthorization, setAgentAuthorization] = useState(false);
  const [draftMessage, setDraftMessage] = useState("Draft is saved automatically on this device.");
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    let offlineValues: Record<string, unknown> = {};
    try { offlineValues = JSON.parse(localStorage.getItem(storageKey) || "{}") as Record<string, unknown>; } catch { localStorage.removeItem(storageKey); }
    return Object.fromEntries(fields.map((field) => [field.key, saved[field.key] ?? offlineValues[field.key] ?? (field.type === "multiselect" ? [] : field.type === "checkbox" ? false : "")]));
  });
  useEffect(() => {
    const safeValues = Object.fromEntries(fields.filter((field) => !["sensitive", "high"].includes(String((field as ServiceFieldDefinition & { sensitivity?: string }).sensitivity))).map((field) => [field.key, values[field.key]]));
    localStorage.setItem(storageKey, JSON.stringify(safeValues));
  }, [fields, storageKey, values]);
  const visibleFields = fields.filter((field) => {
    const dependency = field.depends_on;
    return !dependency || values[dependency.field] === dependency.equals;
  });
  const sections = RTPS_FORM_SECTIONS.map((section) => ({
    ...section,
    fields: visibleFields.filter((field) => rtpsSectionForField(field) === section.key),
  })).filter((section) => section.fields.length > 0);

  function saveDraft() {
    const safeValues = Object.fromEntries(fields
      .filter((field) => !["sensitive", "high"].includes(String((field as ServiceFieldDefinition & { sensitivity?: string }).sensitivity)))
      .map((field) => [field.key, values[field.key]]));
    localStorage.setItem(storageKey, JSON.stringify(safeValues));
    setDraftMessage(`Draft saved at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  }
  return (
    <form className="service-card-form" onSubmit={async (event) => { event.preventDefault(); if (event.currentTarget.reportValidity()) { await onSubmit(requestId, values); localStorage.removeItem(storageKey); } }}>
      <header className="rtps-form-heading">
        <span>ऑनलाइन आवेदन / Online Application</span>
        <h4>{task.service_name}</h4>
        <p>{task.provider}</p>
      </header>
      <aside className="rtps-form-instructions">
        <strong>आवेदक के लिए निर्देश / Instructions</strong>
        <p>Fields marked <b>*</b> are mandatory. Enter details exactly as shown on your supporting documents. Review the form before submission.</p>
      </aside>
      {sections.map((section) => (
        <fieldset className="rtps-form-section" key={section.key}>
          <legend>{section.title}</legend>
          <div className="rtps-field-grid">
            {section.fields.map((field) => (
              <div className={`service-field service-field-${field.type}`} key={field.key}>
                <label htmlFor={`service-field-${field.key}`}>{field.label}{field.required ? <span aria-hidden="true"> *</span> : null}</label>
                <FieldControl field={field} value={values[field.key]} onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} />
                {field.explanation ? <small id={`service-help-${field.key}`}>{field.explanation}</small> : null}
              </div>
            ))}
          </div>
        </fieldset>
      ))}
      {requiresAgentAuthorization ? (
        <label className="rtps-declaration">
          <input type="checkbox" checked={agentAuthorization} onChange={(event) => setAgentAuthorization(event.target.checked)} required />
          <span>I confirm that the information is correct and authorize AutoAI Seva to assign this application to a verified agent. OTP, password, CAPTCHA, PIN and payment secrets are excluded and remain under my control.</span>
        </label>
      ) : null}
      <footer className="rtps-form-actions">
        <p aria-live="polite">{draftMessage}</p>
        <div>
          <button className="service-secondary" type="button" onClick={saveDraft}>Save Draft / प्रारूप सहेजें</button>
          <button className="service-primary" type="submit" disabled={working || !requestId || (requiresAgentAuthorization && !agentAuthorization)}>{working ? <LoaderCircle className="spin" size={17} /> : <ChevronRight size={17} />} {requiresAgentAuthorization ? "Submit application / आवेदन जमा करें" : "Save and continue"}</button>
        </div>
      </footer>
    </form>
  );
}

function DocumentCard({ task, token, update, fail }: { task: ServiceTaskView; token: string; update: (next: ServiceTaskView) => void; fail: (error: unknown) => void }) {
  const requirements = dataValue<DocumentRequirementView[]>(task, "requirements", []);
  const documents = dataValue<DocumentView[]>(task, "documents", []);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [saveChoices, setSaveChoices] = useState<Record<string, boolean>>({});
  const [vaultFor, setVaultFor] = useState("");
  const [vaultAssets, setVaultAssets] = useState<LibraryAsset[]>([]);
  const [analysisSelections, setAnalysisSelections] = useState<Record<string, string[]>>({});
  const [ocrConsent, setOcrConsent] = useState<Record<string, boolean>>({});
  async function upload(requirement: DocumentRequirementView, file?: File) {
    if (!file) return;
    if (file.size > requirement.max_bytes) return fail(new Error(`${requirement.label} must be smaller than ${readableBytes(requirement.max_bytes)}.`));
    try {
      const next = await api.uploadServiceDocument(token, task.id, task.version, requirement.id, file, Boolean(saveChoices[requirement.id]), (value) => setProgress((current) => ({ ...current, [requirement.id]: value })));
      update(next);
    } catch (error) {
      fail(error);
    }
  }
  async function preview(document: DocumentView) {
    if (!document.preview_url) return;
    try {
      const blob = await api.previewServiceDocument(token, document.preview_url);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { fail(error); }
  }
  async function openVault(requirement: DocumentRequirementView) {
    try {
      const page = await api.listLibraryAssets(token, { page: 1 });
      setVaultAssets(page.items.filter((item) => requirement.accepted_mime_types.includes(item.mime_type) && item.file_size <= requirement.max_bytes));
      setVaultFor(requirement.id);
    } catch (error) { fail(error); }
  }
  async function attachVault(requirement: DocumentRequirementView, asset: LibraryAsset) {
    try {
      update(await api.attachServiceVaultDocument(token, task.id, task.version, requirement.id, asset.id));
      setVaultFor("");
    } catch (error) { fail(error); }
  }
  async function decideAnalysis(document: DocumentView, accepted: boolean) {
    const available = Object.keys(document.extracted_fields || {});
    const selected = analysisSelections[document.id] || available;
    try {
      update(await api.decideServiceDocumentAnalysis(token, task.id, task.version, document.id, accepted, accepted ? selected : []));
    } catch (error) { fail(error); }
  }
  return (
    <div className="service-document-list">
      {requirements.map((requirement) => {
        const attached = documents.find((item) => item.requirement_id === requirement.id);
        const percent = progress[requirement.id];
        return (
          <section className="service-document-item" key={requirement.id} aria-label={requirement.label}>
            <div className="service-document-heading"><FileText size={18} /><span><strong>{requirement.label}</strong><small>{requirement.accepted_mime_types.join(", ")} · max {readableBytes(requirement.max_bytes)}</small></span>{attached?.validation_status === "VALID" ? <CheckCircle2 className="service-ok" size={19} /> : null}</div>
            {attached ? <div className="service-file-summary"><FileCheck2 size={16} /><span>{attached.filename}</span><small>{readableBytes(attached.file_size)} · {attached.detected_type || attached.content_type} · {attached.validation_status.toLowerCase()} · OCR {String(attached.ocr_status || "not available").toLowerCase()} · compression: original retained{attached.page_count ? ` · ${attached.page_count} pages` : attached.image_dimensions?.width ? ` · ${attached.image_dimensions.width}×${attached.image_dimensions.height}px` : ""}</small><span className="service-file-summary-actions">{attached.preview_url ? <button type="button" onClick={() => void preview(attached)}>Preview</button> : null}<button type="button" onClick={() => void api.removeServiceDocument(token, task.id, attached.id, task.version).then(update).catch(fail)}>Remove</button></span></div> : null}
            {attached?.warnings?.map((warning) => <p className="service-document-warning" key={warning}><AlertTriangle size={15} />{warning}</p>)}
            {attached && attached.ocr_status === "AVAILABLE_ON_REQUEST" ? <div className="service-ocr-consent"><p>Optional cloud OCR sends only this selected document to the configured vision provider. Extracted suggestions cannot change the form until you approve them.</p><label><input type="checkbox" checked={Boolean(ocrConsent[attached.id])} onChange={(event) => setOcrConsent((current) => ({ ...current, [attached.id]: event.target.checked }))} />I consent to cloud OCR for this document</label><button className="service-secondary" disabled={!ocrConsent[attached.id]} type="button" onClick={() => void api.runServiceDocumentOcr(token, task.id, task.version, attached.id).then(update).catch(fail)}>Run document OCR</button></div> : null}
            {attached && attached.analysis_status === "REVIEW_REQUIRED" ? <div className="service-analysis-review"><strong>Review extracted suggestions</strong>{Object.entries(attached.extracted_fields || {}).map(([key, field]) => { const selected = analysisSelections[attached.id] || Object.keys(attached.extracted_fields || {}); return <label key={key}><input type="checkbox" checked={selected.includes(key)} onChange={(event) => setAnalysisSelections((current) => ({ ...current, [attached.id]: event.target.checked ? [...selected, key] : selected.filter((item) => item !== key) }))} /><span><b>{field.label}</b>: {field.value}<small>Source: embedded document text · Confidence: {Math.round(field.confidence * 100)}%</small></span></label>; })}<div><button className="service-primary" type="button" onClick={() => void decideAnalysis(attached, true)}>Accept selected</button><button className="service-secondary" type="button" onClick={() => void decideAnalysis(attached, false)}>Reject suggestions</button></div></div> : null}
            {typeof percent === "number" && percent < 100 ? <div className="service-upload-progress" aria-label={`Upload ${percent}%`}><span style={{ width: `${percent}%` }} /></div> : null}
            <div className="service-document-actions">
              <label className="service-secondary service-file-button"><Upload size={16} /> {attached ? "Replace" : "Upload from Files"}<input type="file" accept={requirement.accepted_mime_types.join(",")} onChange={(event) => void upload(requirement, event.target.files?.[0])} /></label>
              <button className="service-secondary" type="button" onClick={() => void openVault(requirement)}>Select from AutoAI Vault</button>
              {requirement.accepted_mime_types.some((mime) => mime.startsWith("image/")) ? <><label className="service-secondary service-file-button">Import from Gallery<input type="file" accept="image/jpeg,image/png" onChange={(event) => void upload(requirement, event.target.files?.[0])} /></label><label className="service-secondary service-file-button">Take new photo<input type="file" accept="image/jpeg,image/png" capture="environment" onChange={(event) => void upload(requirement, event.target.files?.[0])} /></label></> : null}
            </div>
            {vaultFor === requirement.id ? <div className="service-vault-picker" role="region" aria-label={`Vault files for ${requirement.label}`}>{vaultAssets.length ? vaultAssets.map((asset) => <button type="button" key={asset.id} onClick={() => void attachVault(requirement, asset)}><FileText size={15} /><span>{asset.display_name}<small>{readableBytes(asset.file_size)} · {asset.mime_type}</small></span></button>) : <p>No compatible vault documents were found.</p>}</div> : null}
            <label className="service-check"><input type="checkbox" checked={Boolean(saveChoices[requirement.id])} onChange={(event) => setSaveChoices((current) => ({ ...current, [requirement.id]: event.target.checked }))} /><span>{saveChoices[requirement.id] ? "Save to AutoAI Vault" : "Use only for this application"}</span></label>
          </section>
        );
      })}
    </div>
  );
}

function ReviewCard({ task }: { task: ServiceTaskView }) {
  const summary = dataValue<Record<string, unknown>>(task, "summary", {});
  const rows = Array.isArray(summary.applicant_information) ? summary.applicant_information as Array<Record<string, unknown>> : [];
  const documents = dataValue<DocumentView[]>(task, "documents", []);
  const fee = dataValue<Record<string, unknown>>(task, "fee", {});
  return (
    <div className="service-review">
      <dl>{rows.map((row) => <div key={String(row.key)}><dt>{String(row.label)}</dt><dd>{String(row.value ?? "Not provided")}</dd><small>Source: {String(row.source)} · Confidence: {String(row.confidence)}</small></div>)}</dl>
      <div className="service-review-meta"><span>Documents <strong>{documents.length}</strong></span><span>Fee <strong>{String(fee.label ?? fee.amount ?? "Check portal")}</strong></span><span>Destination <strong>{dataValue<string>(task, "destination_portal", "")}</strong></span></div>
    </div>
  );
}

function WorkflowWorkingCard({ workflow, startedAt, latestEvent }: { workflow: WorkflowSummary; startedAt: number; latestEvent: ServiceTaskEvent | null }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const operation = String(latestEvent?.details.reason || workflow.current_operation || "Processing the current verified step");
  return <section className="service-workflow-working" aria-live="polite" aria-label="Workflow working">
    <LoaderCircle className="spin" size={19} />
    <span><strong>{operation}</strong><small>Step {workflow.current_step || 1} of {workflow.total_steps || 1} · {elapsedSeconds}s elapsed</small></span>
  </section>;
}

function ApplicationPreview({ preview, open, onToggle }: { preview: ApplicationPreviewData; open: boolean; onToggle: () => void }) {
  const fields = preview.fields || [];
  const documents = preview.documents || [];
  return <section className="service-application-preview" aria-label="Application preview">
    <header><span><FileCheck2 size={17} /><strong>Application preview</strong></span><button className="service-secondary" type="button" aria-expanded={open} onClick={onToggle}>{open ? "Hide preview" : "Open full preview"}</button></header>
    <div className="service-preview-summary"><span><small>Portal</small><b>{preview.portal_name || "Preparing application"}</b></span><span><small>Status</small><b>{preview.current_stage || "Preparing"}</b></span><span><small>Completed</small><b>{preview.completed_fields || 0}/{preview.total_fields || 0} fields</b></span></div>
    <p>Currently filling: <strong>{preview.currently_filling || "Loading requirements"}</strong></p>
    {open ? <div className="service-preview-detail"><dl>{fields.map((field) => <div key={field.key} className={field.status === "complete" ? "complete" : "missing"}><dt>{field.label}</dt><dd>{String(field.value)}</dd><small>Source: {field.source} · {field.confidence}</small></div>)}</dl>{documents.length ? <div className="service-preview-documents"><strong>Documents</strong>{documents.map((document) => <span key={`${document.label}-${document.filename}`}><FileText size={14} />{document.label}: {document.filename} · {document.status}</span>)}</div> : null}<small className="service-preview-origin">Verified destination: {preview.official_origin || "AutoAI local adapter"}</small></div> : null}
  </section>;
}

function ReceiptCard({ task }: { task: ServiceTaskView }) {
  const data = task.active_card.data;
  const evidence = Array.isArray(data.evidence) ? data.evidence as Array<Record<string, unknown>> : [];
  return (
    <div className="service-receipt">
      <div className={task.state === "COMPLETED_VERIFIED" ? "service-receipt-status verified" : "service-receipt-status unverified"}>{task.state === "COMPLETED_VERIFIED" ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}<strong>{String(data.status || stateLabel(task.state))}</strong></div>
      <dl><div><dt>Application ID</dt><dd>{String(data.application_id || "Not provided")}</dd></div><div><dt>Transaction ID</dt><dd>{String(data.transaction_id || "Not provided")}</dd></div><div><dt>Portal</dt><dd>{String(data.verified_portal || "AutoAI local adapter")}</dd></div><div><dt>Submitted</dt><dd>{data.submission_timestamp ? new Date(String(data.submission_timestamp)).toLocaleString() : "Not verified"}</dd></div></dl>
      {evidence.map((item, index) => <div className="service-evidence" key={`${String(item.type)}-${index}`}><FileCheck2 size={16} /><span>{String(item.type)}</span><strong>{item.verified ? "Verified" : "Unverified"}</strong></div>)}
    </div>
  );
}

export function ServiceTaskCard({ task: initialTask, token }: Props) {
  const [task, setTask] = useState(initialTask);
  const [status, setStatus] = useState<CardStatus>("idle");
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [declaration, setDeclaration] = useState(false);
  const [secureValue, setSecureValue] = useState("");
  const [requirementsOpen, setRequirementsOpen] = useState(false);
  const [filledFieldsOpen, setFilledFieldsOpen] = useState(false);
  const [portalOutcomeOpen, setPortalOutcomeOpen] = useState(false);
  const [applicationId, setApplicationId] = useState("");
  const [transactionId, setTransactionId] = useState("");
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffPurpose, setHandoffPurpose] = useState("Help me complete this service safely");
  const [approvedFields, setApprovedFields] = useState<string[]>([]);
  const [approvedDocuments, setApprovedDocuments] = useState<string[]>([]);
  const [handoffResult, setHandoffResult] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [latestEvent, setLatestEvent] = useState<ServiceTaskEvent | null>(null);
  const [eventStreamKey, setEventStreamKey] = useState(0);
  const [workingStartedAt, setWorkingStartedAt] = useState<number | null>(null);
  const idempotencyRef = useRef<string>(crypto.randomUUID());
  const latestEventIdRef = useRef("");

  useEffect(() => setTask(initialTask), [initialTask]);
  useEffect(() => {
    const online = () => setOffline(false);
    const offlineHandler = () => setOffline(true);
    window.addEventListener("online", online);
    window.addEventListener("offline", offlineHandler);
    return () => { window.removeEventListener("online", online); window.removeEventListener("offline", offlineHandler); };
  }, []);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let refreshScheduled = false;
    const refresh = () => {
      if (refreshScheduled || controller.signal.aborted) return;
      refreshScheduled = true;
      window.setTimeout(() => {
        refreshScheduled = false;
        if (controller.signal.aborted) return;
        void api.getServiceTask(token, task.id)
          .then((next) => setTask((current) => new Date(next.updated_at) >= new Date(current.updated_at) ? next : current))
          .catch((cause) => {
            if (!controller.signal.aborted) setError(cause instanceof Error ? `Live update unavailable: ${cause.message}` : "Live update is temporarily unavailable. Use refresh to retry.");
          });
      }, 100);
    };
    void streamServiceTaskEvents(token, task.id, (event) => {
      if (event.id === latestEventIdRef.current) return;
      latestEventIdRef.current = event.id;
      setLatestEvent(event);
      refresh();
    }, { after: latestEventIdRef.current || undefined, signal: controller.signal }).catch((cause) => {
      if (!controller.signal.aborted && cause instanceof Error) setError(`Live update unavailable: ${cause.message}`);
    });
    return () => controller.abort();
  }, [eventStreamKey, task.id, token]);

  const update = (next: ServiceTaskView) => { setTask(next); setStatus("success"); setWorkingStartedAt(null); setError(""); setEventStreamKey((value) => value + 1); window.setTimeout(() => setStatus("idle"), 1200); };
  const fail = (cause: unknown) => { setStatus("error"); setError(cause instanceof Error ? cause.message : "The service step could not be completed. Retry is safe."); };
  const run = async (work: () => Promise<ServiceTaskView>) => {
    if (!token || status === "working") return;
    setStatus("working"); setWorkingStartedAt(Date.now()); setError(""); setEventStreamKey((value) => value + 1);
    try { update(await work()); } catch (cause) { fail(cause); }
  };
  const card = task.active_card;
  const officialOrigin = dataValue<string>(task, "official_origin", "");
  const entryUrl = dataValue<string>(task, "entry_url", "");
  const secureChallengeId = dataValue<string>(task, "challenge_id", "");
  const workflow = dataValue<WorkflowSummary>(task, "workflow", {});
  const preview = dataValue<ApplicationPreviewData>(task, "application_preview", {});
  const isBusy = status === "working";

  async function openPortal() {
    if (!token) return;
    setStatus("working"); setError("");
    try {
      const next = card.type === "portal_session" || task.state === "AWAITING_AUTHENTICATION" || task.state === "AWAITING_USER_ACTION" ? task : await api.createServicePortalSession(token, task.id, task.version);
      setTask(next);
      const url = dataValue<string>(next, "entry_url", entryUrl);
      const origin = dataValue<string>(next, "official_origin", officialOrigin);
      if (!url || !origin) throw new Error("Verified portal destination is unavailable.");
      await serviceNative.openPortal(url, origin);
      setStatus("success");
    } catch (cause) { fail(cause); }
  }

  async function allowCamera() {
    if (!token) return;
    setStatus("working"); setError("");
    try {
      const nativeStatus: NativePermissionStatus = await serviceNative.requestCamera();
      const permissionId = dataValue<string>(task, "permission_id", "");
      update(await api.resolveServicePermission(token, task.id, permissionId, task.version, nativeStatus));
    } catch (cause) { fail(cause); }
  }

  async function printApplication() {
    setError("");
    try {
      await serviceNative.printHtml(`${task.service_name} application`, printableApplicationHtml(task));
    } catch (cause) {
      fail(cause);
    }
  }

  async function reportPortalOutcome(outcome: "submitted" | "rejected" | "not_submitted" | "unknown") {
    if (!token) return;
    await run(() => api.reportServicePortalOutcome(token, task.id, task.version, outcome, applicationId.trim(), transactionId.trim()));
  }

  async function requestHandoff() {
    if (!token || !handoffPurpose.trim()) return;
    setStatus("working"); setError(""); setHandoffResult("");
    try {
      await api.requestServiceHandoff(token, task.id, task.version, approvedFields, approvedDocuments, handoffPurpose.trim());
      setHandoffResult("Handoff request saved. No agent has been assigned yet, and only the selected items may be shared.");
      setStatus("success");
      setTask(await api.getServiceTask(token, task.id));
    } catch (cause) { fail(cause); }
  }

  async function revokeHandoff(handoffId: string) {
    if (!token) return;
    await run(() => api.revokeServiceHandoff(token, task.id, handoffId, task.version));
    setHandoffResult("Handoff access revoked immediately.");
  }

  const headingIcon = useMemo(() => {
    if (card.type === "secure_input_request") return <LockKeyhole size={19} />;
    if (card.type === "action_receipt") return <FileCheck2 size={19} />;
    if (card.type === "task_error") return <AlertTriangle size={19} />;
    return <ShieldCheck size={19} />;
  }, [card.type]);

  return (
    <section className="service-task-card not-prose" aria-label={card.title} data-state={task.state}>
      <header className="service-card-header"><span className="service-card-icon">{headingIcon}</span><span><span className="service-card-kicker">{task.execution_mode.replace(/_/g, " ")} · {stateLabel(task.state)}</span><h3>{card.title}</h3><p>{card.description}</p></span></header>
      <div className="service-progress"><span style={{ width: `${task.progress_percent}%` }} /></div>
      <span className="sr-only" aria-live="polite">{status === "working" ? "Working" : status === "success" ? "Step saved" : error}</span>
      {isBusy && workingStartedAt ? <WorkflowWorkingCard workflow={workflow} startedAt={workingStartedAt} latestEvent={latestEvent} /> : null}
      {offline ? <div className="service-inline-warning"><AlertTriangle size={16} /> Offline: saved non-secret fields remain visible, but external actions will wait for connectivity.</div> : null}
      {card.type === "service_plan" ? <div className="service-plan"><div className="service-plan-grid"><span><small>Service</small><strong>{String(card.data.service)}</strong></span><span><small>Provider</small><strong>{String(card.data.provider)}</strong></span><span><small>Estimated steps</small><strong>{String(card.data.estimated_steps)}</strong></span><span><small>Portal</small><strong>{String(card.data.official_origin || "Safe local test")}</strong></span></div><p className="service-mode-notice">{String(card.data.mode_notice || "")}</p>{requirementsOpen ? <div className="service-requirements-detail"><strong>Information</strong><ul>{dataValue<string[]>(task, "requirements", []).map((item) => <li key={item}><CheckCircle2 size={15} />{item}</li>)}</ul><strong>Documents</strong>{dataValue<string[]>(task, "required_documents", []).length ? <ul>{dataValue<string[]>(task, "required_documents", []).map((item) => <li key={item}><FileText size={15} />{item}</li>)}</ul> : <p>No documents required.</p>}</div> : null}</div> : null}
      {card.type === "information_request" && token ? <InformationCard task={task} working={isBusy} onSubmit={(requestId, values) => run(() => api.saveServiceFields(token, task.id, task.version, requestId, values))} /> : null}
      {card.type === "document_request" && token ? <DocumentCard task={task} token={token} update={update} fail={fail} /> : null}
      {card.type === "permission_request" ? <div className="service-permission"><dl><div><dt>Capability</dt><dd>{String(card.data.capability || "")}</dd></div><div><dt>Data accessed</dt><dd>{dataValue<string[]>(task, "data_accessed", []).join(", ")}</dd></div><div><dt>Retention</dt><dd>{String(card.data.retention || "")}</dd></div><div><dt>Processing</dt><dd>{String(card.data.processing_location || "")}</dd></div></dl><p>{String(card.data.revoke_instructions || "")}</p></div> : null}
      {card.type === "secure_input_request" ? <div className="service-secure"><ShieldCheck size={25} /><p>AutoAI cannot read or remember this code. It is sent only to <strong>{officialOrigin}</strong> for this active session.</p>{secureChallengeId ? <form onSubmit={(event) => { event.preventDefault(); const value = secureValue; setSecureValue(""); if (token && value) void run(() => api.submitServiceSecureResponse(token, task.id, secureChallengeId, value)); }}><label>One-time code<input type="password" value={secureValue} inputMode="numeric" autoComplete="one-time-code" maxLength={8} onChange={(event) => setSecureValue(event.target.value.replace(/\D/g, ""))} onCopy={(event) => event.preventDefault()} required /></label><small>The value is excluded from chat, model context, analytics, receipts, and storage.</small><button className="service-primary" disabled={isBusy || !secureValue} type="submit">Verify securely</button></form> : <p>The previous secure code is unavailable or expired. Request a new isolated verification session.</p>}</div> : null}
      {card.type === "portal_session" || card.type === "user_action_required" ? <div className="service-portal"><div className="service-portal-domain"><ShieldCheck size={17} /><span><small>Verified official destination</small><strong>{officialOrigin}</strong></span></div><dl><div><dt>Current step</dt><dd>{String(card.data.current_step || card.data.kind || "User verification")}</dd></div><div><dt>Session expires</dt><dd>{card.data.session_expiry || card.data.expires_at ? new Date(String(card.data.session_expiry || card.data.expires_at)).toLocaleTimeString() : "Shown on portal"}</dd></div></dl></div> : null}
      {card.type === "portal_session" && filledFieldsOpen ? <ReviewCard task={task} /> : null}
      {card.type === "portal_session" && portalOutcomeOpen ? <form className="service-outcome-form" onSubmit={(event) => { event.preventDefault(); void reportPortalOutcome("submitted"); }}><p>Report only what the official portal showed. AutoAI will keep this unverified until independent evidence is available.</p><label>Application ID (optional)<input value={applicationId} maxLength={180} onChange={(event) => setApplicationId(event.target.value)} /></label><label>Transaction ID (optional)<input value={transactionId} maxLength={180} onChange={(event) => setTransactionId(event.target.value)} /></label><div><button className="service-primary" disabled={isBusy || offline} type="submit">Report submitted</button><button className="service-secondary" disabled={isBusy} onClick={() => void reportPortalOutcome("not_submitted")} type="button">Not submitted</button><button className="service-quiet-danger" disabled={isBusy} onClick={() => void reportPortalOutcome("rejected")} type="button">Report rejected</button></div></form> : null}
      {card.type === "form_review" ? <ReviewCard task={task} /> : null}
      {card.type === "submission_confirmation" ? <div className="service-confirmation"><dl><div><dt>Application</dt><dd>{String(card.data.application)}</dd></div><div><dt>Portal</dt><dd>{String(card.data.portal)}</dd></div><div><dt>Documents</dt><dd>{String(card.data.documents)}</dd></div><div><dt>Fee</dt><dd>{String((card.data.fee as Record<string, unknown> | undefined)?.label || "Check portal")}</dd></div></dl><label className="service-declaration"><input type="checkbox" checked={declaration || Boolean(card.data.confirmed)} disabled={Boolean(card.data.confirmed)} onChange={(event) => setDeclaration(event.target.checked)} /><span>{String(card.data.declaration)}</span></label></div> : null}
      {card.type === "action_receipt" ? <ReceiptCard task={task} /> : null}
      {handoffOpen && dataValue<ActiveHandoff[]>(task, "active_handoffs", []).length ? <section className="service-handoff service-handoff-active-list" aria-label="Active human assistance"><h4>Active assistance access</h4>{dataValue<ActiveHandoff[]>(task, "active_handoffs", []).map((handoff) => <article className="service-handoff-active" key={handoff.id}><strong>{handoff.purpose}</strong><small>Agent: {handoff.agent_identity.verified ? "verified" : handoff.agent_identity.status || "unassigned"} · expires {new Date(handoff.expires_at).toLocaleTimeString()}</small><button className="service-quiet-danger" disabled={isBusy} onClick={() => void revokeHandoff(handoff.id)} type="button">Revoke access</button></article>)}</section> : null}
      {card.type === "task_progress" ? <div className="service-step-list">{dataValue<Array<{ label: string; complete: boolean }>>(task, "steps", []).map((step) => <span key={step.label} className={step.complete ? "complete" : ""}>{step.complete ? <CheckCircle2 size={17} /> : <span className="service-step-dot" />}{step.label}</span>)}</div> : null}
      {card.type === "task_error" || card.type === "recovery_options" ? <div className="service-recovery"><AlertTriangle size={19} /><span><strong>{String(card.data.code || stateLabel(task.state))}</strong><p>{card.description}</p></span></div> : null}
      <ApplicationPreview preview={preview} open={previewOpen} onToggle={() => setPreviewOpen((value) => !value)} />
      {handoffOpen ? <section className="service-handoff" aria-label="Human assistance handoff"><h4>Approve exactly what may be shared</h4><p>Passwords, OTPs, PINs, biometrics, and unrelated data are never included. Final authentication and submission remain yours.</p><fieldset><legend>Information fields</legend>{dataValue<ShareableField[]>(task, "shareable_fields", []).length ? dataValue<ShareableField[]>(task, "shareable_fields", []).map((field) => <label key={field.key}><input type="checkbox" checked={approvedFields.includes(field.key)} onChange={(event) => setApprovedFields((current) => event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key))} />{field.label}</label>) : <small>No information fields selected.</small>}</fieldset><fieldset><legend>Documents</legend>{dataValue<DocumentView[]>(task, "shareable_documents", []).length ? dataValue<DocumentView[]>(task, "shareable_documents", []).map((document) => <label key={document.id}><input type="checkbox" checked={approvedDocuments.includes(document.id)} onChange={(event) => setApprovedDocuments((current) => event.target.checked ? [...current, document.id] : current.filter((id) => id !== document.id))} />{document.label}: {document.filename}</label>) : <small>No documents selected.</small>}</fieldset><label>Purpose<input value={handoffPurpose} minLength={3} maxLength={240} onChange={(event) => setHandoffPurpose(event.target.value)} /></label>{handoffResult ? <p role="status">{handoffResult}</p> : null}<button className="service-primary" disabled={isBusy || !handoffPurpose.trim()} onClick={() => void requestHandoff()} type="button">Approve handoff request</button></section> : null}
      {error ? <div className="service-inline-error" role="alert"><XCircle size={16} /><span>{error}</span><button type="button" onClick={() => setError("")}>Dismiss</button></div> : null}
      <div className="service-card-actions">
        {card.actions.includes("start") && token ? <button className="service-primary" disabled={isBusy} onClick={() => void run(() => api.startServiceTask(token, task.id, task.version))} type="button">Start application</button> : null}
        {card.actions.includes("requirements") ? <button className="service-secondary" aria-expanded={requirementsOpen} onClick={() => setRequirementsOpen((value) => !value)} type="button">{requirementsOpen ? "Hide requirements" : "View requirements"}</button> : null}
        {card.actions.includes("change_service") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "cancel", task.version))} type="button">Change service</button> : null}
        {card.actions.includes("prepare") && token ? <button className="service-primary" disabled={isBusy} onClick={() => void run(() => api.prepareServiceTask(token, task.id, task.version))} type="button">Prepare draft</button> : null}
        {card.actions.includes("confirm_information") && token ? <button className="service-primary" disabled={isBusy} onClick={() => void run(() => api.approveServiceReview(token, task.id, task.version))} type="button">Confirm information</button> : null}
        {card.actions.includes("confirm_submission") && token ? <button className="service-primary" disabled={isBusy || !declaration} onClick={() => void run(async () => { const native = dataValue<boolean>(task, "high_risk", false) ? await serviceNative.confirmHighRisk(task.service_name, "Confirm this reviewed application") : "unavailable"; return api.confirmServiceSubmission(token, task.id, task.version, native); })} type="button"><Fingerprint size={17} /> Confirm submission</button> : null}
        {card.actions.includes("confirm_and_submit") && token ? <button className="service-danger" disabled={isBusy || offline} onClick={() => void run(() => api.submitServiceTask(token, task.id, task.version, dataValue<string>(task, "confirmation_id", ""), idempotencyRef.current))} type="button"><ShieldCheck size={17} /> Confirm and submit</button> : null}
        {card.actions.includes("open_portal") ? <button className="service-primary" disabled={isBusy || offline} onClick={() => void openPortal()} type="button"><ExternalLink size={17} /> Open verified portal</button> : null}
        {card.actions.includes("continue") ? <button className="service-secondary" disabled={isBusy || offline} onClick={() => void openPortal()} type="button">Continue on portal</button> : null}
        {card.actions.includes("take_control") ? <button className="service-secondary" disabled={isBusy || offline} onClick={() => void openPortal()} type="button">Take control</button> : null}
        {card.actions.includes("view_filled_fields") ? <button className="service-secondary" aria-expanded={filledFieldsOpen} onClick={() => setFilledFieldsOpen((value) => !value)} type="button">View filled fields</button> : null}
        {card.type === "portal_session" ? <button className="service-secondary" aria-expanded={portalOutcomeOpen} onClick={() => setPortalOutcomeOpen((value) => !value)} type="button">Report portal result</button> : null}
        {card.actions.includes("report_wrong_portal") && token ? <button className="service-quiet-danger" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "cancel", task.version))} type="button">Report wrong portal</button> : null}
        {card.actions.includes("verification_completed") && token ? <button className="service-primary" disabled={isBusy} onClick={() => void run(() => api.completeServiceHumanAction(token, task.id, task.version, (String(card.data.kind || "otp") as "otp" | "password" | "captcha" | "biometric" | "digital_signature" | "payment" | "consent_declaration" | "physical_verification")))} type="button">Verification completed</button> : null}
        {card.actions.includes("request_new_code") && token ? <button className="service-primary" disabled={isBusy || offline} onClick={() => void run(() => api.createServiceSecureChallenge(token, task.id, task.version, "otp"))} type="button">Request new code</button> : null}
        {card.actions.includes("scan_camera") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.requestServicePermission(token, task.id, task.version, "camera"))} type="button">Scan with camera</button> : null}
        {card.actions.includes("allow_once") ? <button className="service-primary" disabled={isBusy} onClick={() => void allowCamera()} type="button">Allow once</button> : null}
        {card.actions.includes("continue_without") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.resolveServicePermission(token, task.id, dataValue<string>(task, "permission_id", ""), task.version, "DENIED"))} type="button">Continue without camera</button> : null}
        {card.actions.includes("open_settings") ? <button className="service-secondary" onClick={() => void serviceNative.openSettings()} type="button">Open Android Settings</button> : null}
        {card.actions.includes("view_receipt") || card.type === "action_receipt" ? <button className="service-primary" disabled={isBusy} onClick={() => void printApplication()} type="button"><Printer size={16} /> Print application</button> : null}
        {card.actions.includes("view_receipt") || card.type === "action_receipt" ? <button className="service-secondary" disabled={isBusy} onClick={() => downloadPrintableApplication(task)} type="button"><Download size={16} /> Download printable summary</button> : null}
        {card.actions.includes("track") && token ? <button className="service-secondary" disabled={isBusy || offline} onClick={() => void (async () => { setStatus("working"); try { await api.trackServiceTask(token, task.id); update(await api.getServiceTask(token, task.id)); } catch (cause) { fail(cause); } })()} type="button"><RefreshCw size={16} /> Track</button> : null}
        {card.actions.includes("retry") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "retry", task.version))} type="button"><RotateCcw size={16} /> Retry</button> : null}
        {(card.actions.includes("retry_verification") || card.actions.includes("recovery")) && token ? <button className="service-secondary" disabled={isBusy || offline} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "retry", task.version))} type="button"><RotateCcw size={16} /> Verify again</button> : null}
        {card.actions.includes("human_help") ? <button className="service-secondary" aria-expanded={handoffOpen} onClick={() => setHandoffOpen((value) => !value)} type="button">Human assistance</button> : null}
        {card.actions.includes("resume") && token ? <button className="service-primary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "resume", task.version))} type="button">Resume</button> : null}
        {card.actions.includes("pause") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "pause", task.version))} type="button"><CirclePause size={16} /> Pause</button> : null}
        {card.actions.includes("review_again") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "review-again", task.version))} type="button">Review again</button> : null}
        {card.actions.includes("edit") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "edit", task.version))} type="button">Edit information</button> : null}
        {card.actions.includes("edit_documents") && token ? <button className="service-secondary" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "edit-documents", task.version))} type="button">Review documents</button> : null}
        {card.actions.includes("cancel") && token ? <button className="service-quiet-danger" disabled={isBusy} onClick={() => void run(() => api.serviceTaskAction(token, task.id, "cancel", task.version))} type="button">Cancel</button> : null}
        <button className="service-icon-button" title="Refresh task" aria-label="Refresh task" disabled={isBusy || !token} onClick={() => token && void run(() => api.getServiceTask(token, task.id))} type="button"><RefreshCw size={16} /></button>
      </div>
      {isBusy ? <div className="service-working"><LoaderCircle className="spin" size={16} /> Processing this step safely…</div> : null}
    </section>
  );
}
