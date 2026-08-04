import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileUp,
  LoaderCircle,
  LockKeyhole,
  PauseCircle,
  RotateCcw,
  XCircle
} from "lucide-react";

import { api } from "../../api/client";
import type { IntentFieldType, IntentInteraction } from "../../types";

const supported = new Set<IntentFieldType>([
  "text",
  "email",
  "phone",
  "number",
  "date",
  "time",
  "address",
  "select",
  "multiselect",
  "radio",
  "checkbox",
  "textarea",
  "file",
  "camera",
  "pdf",
  "image",
  "signature",
  "secure_password",
  "otp",
  "captcha",
  "biometric",
  "permission",
  "review",
  "confirmation",
  "progress",
  "receipt"
]);

type InteractionStatus = "idle" | "sending" | "complete" | "error";
type Decision = "submit" | "confirm" | "cancel" | "retry" | "pause";

function initialValues(interaction: IntentInteraction): Record<string, unknown> {
  return Object.fromEntries(
    interaction.fields.map((field) => [
      field.id,
      field.type === "multiselect" ? [] : field.type === "checkbox" || field.type === "permission" ? false : ""
    ])
  );
}

function actionLabel(action: IntentInteraction["actions"][number]) {
  return {
    submit: "Save and continue",
    confirm: "Confirm and continue",
    cancel: "Cancel",
    retry: "Retry",
    undo: "Undo",
    pause: "Pause",
    authenticate: "Verify securely"
  }[action];
}

function actionIcon(action: IntentInteraction["actions"][number], sending: boolean) {
  if (sending) return <LoaderCircle className="animate-spin" size={16} />;
  if (action === "cancel") return <XCircle size={16} />;
  if (action === "pause") return <PauseCircle size={16} />;
  if (action === "retry" || action === "undo") return <RotateCcw size={16} />;
  return <ChevronRight size={16} />;
}

function completionMessage(decision: Decision, interaction: IntentInteraction, state: string) {
  const readableState = state.replace(/_/g, " ").toLowerCase();
  if (decision === "cancel") return "Workflow cancelled. No further action will run.";
  if (decision === "pause") return `Workflow paused at ${readableState}. You can resume it later.`;
  if (decision === "retry") return `Retry accepted. AutoAI is continuing from ${readableState}.`;
  if (decision === "confirm") return `Confirmation saved. AutoAI is preparing the next required step (${readableState}).`;
  return `${interaction.title} saved. AutoAI is preparing the next required step (${readableState}).`;
}

export function DynamicInteractionCard({ interaction, token }: { interaction: IntentInteraction; token?: string | null }) {
  const interactionKey = useMemo(
    () => `${interaction.workflow_id || "none"}:${interaction.type}:${interaction.title}:${interaction.fields.map((field) => `${field.id}:${field.type}`).join("|")}`,
    [interaction]
  );
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(interaction));
  const [status, setStatus] = useState<InteractionStatus>("idle");
  const [error, setError] = useState("");
  const [completion, setCompletion] = useState("");
  const [persistedState, setPersistedState] = useState("");

  useEffect(() => {
    setValues(initialValues(interaction));
    setStatus("idle");
    setError("");
    setCompletion("");
    setPersistedState("");
  }, [interactionKey, interaction]);

  function setFieldValue(fieldId: string, value: unknown) {
    setValues((current) => ({ ...current, [fieldId]: value }));
    if (error) setError("");
  }

  function validateRequiredFields() {
    const missing = interaction.fields
      .filter((field) => supported.has(field.type) && field.required)
      .filter((field) => {
        const value = values[field.id];
        return value === undefined || value === null || value === "" || value === false || (Array.isArray(value) && value.length === 0);
      })
      .map((field) => field.label);
    if (!missing.length) return true;
    setError(`Complete ${missing.join(", ")} before continuing.`);
    return false;
  }

  async function act(decision: Decision) {
    if (!token || !interaction.workflow_id) {
      setError("This workflow session is unavailable. Refresh the chat and try again.");
      return;
    }
    if ((decision === "submit" || decision === "confirm") && !validateRequiredFields()) return;
    setStatus("sending");
    setError("");
    try {
      const result = await api.submitIntentInteraction(token, interaction.workflow_id, { values, decision });
      if (!result.workflow_id || !result.state) throw new Error("The workflow did not confirm persistence.");
      setPersistedState(result.state);
      setCompletion(completionMessage(decision, interaction, result.state));
      setStatus("complete");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to continue workflow");
      setStatus("error");
    }
  }

  async function authenticate() {
    if (!token || !interaction.workflow_id) {
      setError("This secure workflow session is unavailable. Refresh the chat and try again.");
      return;
    }
    const secretField = interaction.fields.find((field) => field.type === "otp" || field.type === "secure_password");
    const secret = String(values[secretField?.id || "secret"] || "");
    if (!secret) {
      setError("Enter the secure value.");
      return;
    }
    setStatus("sending");
    setError("");
    try {
      const challenge = await api.createSecureChallenge(token, interaction.workflow_id, secretField?.type === "secure_password" ? "password" : "otp");
      const result = await api.submitSecureChallenge(token, challenge.id, secret);
      if (!result.workflow_id || !result.status) throw new Error("The secure workflow did not confirm persistence.");
      setValues(initialValues(interaction));
      setPersistedState(result.status);
      setCompletion("Secure verification accepted for this active workflow. The value was removed from this screen.");
      setStatus("complete");
    } catch (cause) {
      setValues(initialValues(interaction));
      setError(cause instanceof Error ? cause.message : "Secure verification failed");
      setStatus("error");
    }
  }

  if (status === "complete") {
    return (
      <section className="not-prose mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4" aria-live="polite">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-300" size={18} />
          <div className="min-w-0">
            <strong className="block text-sm text-white">Step completed</strong>
            <p className="mt-1 text-xs leading-5 text-emerald-50/90">{completion}</p>
            {persistedState ? <span className="mt-2 inline-flex rounded-full border border-emerald-300/25 px-2 py-1 text-[11px] text-emerald-100">{persistedState.replace(/_/g, " ")}</span> : null}
          </div>
        </div>
      </section>
    );
  }

  const isSecure = interaction.type === "secure_input";
  const progressOnly = interaction.type === "workflow_progress" && interaction.fields.length === 0;

  return (
    <section className="not-prose mt-3 overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-950/70" aria-label={interaction.title}>
      <header className="border-b border-white/10 bg-white/[0.03] px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-100">
            {isSecure ? <LockKeyhole size={17} /> : status === "sending" ? <LoaderCircle className="animate-spin" size={17} /> : <ChevronRight size={17} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/70">AutoAI workflow</span>
            <h3 className="mt-1 text-sm font-semibold text-white">{interaction.title}</h3>
            {interaction.description ? <p className="mt-1 text-xs leading-5 text-slate-300">{interaction.description}</p> : null}
          </span>
        </div>
      </header>

      <div className="p-4">
        {progressOnly ? (
          <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-200">
            <LoaderCircle className="animate-spin text-cyan-200" size={18} />
            <span>AutoAI is working on the current step. This card will update when real progress is received.</span>
          </div>
        ) : null}

        <div className="grid gap-3">
          {interaction.fields.map((field) => {
            if (!supported.has(field.type)) return null;
            const fieldId = `intent-${field.id}`;
            const commonClass = "w-full min-w-0 rounded-xl border border-white/15 bg-slate-900 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-300/60";
            const label = <span className="text-xs font-medium text-slate-200">{field.label}{field.required ? " *" : ""}</span>;

            if (field.type === "textarea" || field.type === "address") {
              return <label key={field.id} className="grid gap-1.5">{label}<textarea id={fieldId} required={field.required} className={commonClass} rows={3} value={String(values[field.id] ?? "")} onChange={(event) => setFieldValue(field.id, event.target.value)} /></label>;
            }
            if (field.type === "select") {
              return <label key={field.id} className="grid gap-1.5">{label}<select id={fieldId} required={field.required} className={commonClass} value={String(values[field.id] ?? "")} onChange={(event) => setFieldValue(field.id, event.target.value)}><option value="">Select an option</option>{(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
            }
            if (field.type === "radio") {
              return <fieldset key={field.id} className="grid gap-2 rounded-xl border border-white/10 p-3"><legend className="px-1 text-xs font-medium text-slate-200">{field.label}{field.required ? " *" : ""}</legend>{(field.options || []).map((option) => <label key={option} className="flex items-center gap-2 text-sm text-slate-200"><input type="radio" name={fieldId} value={option} checked={values[field.id] === option} onChange={() => setFieldValue(field.id, option)} />{option}</label>)}</fieldset>;
            }
            if (field.type === "multiselect") {
              const selected = Array.isArray(values[field.id]) ? values[field.id].map(String) : [];
              return <fieldset key={field.id} className="grid gap-2 rounded-xl border border-white/10 p-3"><legend className="px-1 text-xs font-medium text-slate-200">{field.label}{field.required ? " *" : ""}</legend>{(field.options || []).map((option) => <label key={option} className="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={selected.includes(option)} onChange={(event) => setFieldValue(field.id, event.target.checked ? [...selected, option] : selected.filter((item) => item !== option))} />{option}</label>)}</fieldset>;
            }
            if (field.type === "checkbox" || field.type === "permission" || field.type === "confirmation") {
              return <label key={field.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-sm text-slate-200"><input className="mt-0.5" id={fieldId} required={field.required} type="checkbox" checked={Boolean(values[field.id])} onChange={(event) => setFieldValue(field.id, event.target.checked)} /><span>{field.label}{field.required ? " *" : ""}</span></label>;
            }
            if (["file", "camera", "pdf", "image", "signature"].includes(field.type)) {
              const accept = field.type === "pdf" ? "application/pdf" : field.type === "image" || field.type === "camera" || field.type === "signature" ? "image/*" : undefined;
              return <label key={field.id} className="grid gap-1.5">{label}<span className="flex items-center gap-2 rounded-xl border border-dashed border-cyan-300/30 bg-cyan-400/[0.04] px-3 py-3 text-xs text-slate-200"><FileUp size={16} /><input id={fieldId} required={field.required} type="file" accept={accept} capture={field.type === "camera" ? "environment" : undefined} onChange={(event) => { const file = event.target.files?.[0]; setFieldValue(field.id, file ? { name: file.name, size: file.size, type: file.type } : ""); }} /></span></label>;
            }

            const inputType = field.type === "secure_password" || field.type === "otp" ? "password" : field.type === "phone" ? "tel" : ["email", "number", "date", "time"].includes(field.type) ? field.type : "text";
            return <label key={field.id} className="grid gap-1.5">{label}<input id={fieldId} required={field.required} className={commonClass} type={inputType} value={String(values[field.id] ?? "")} min={field.validation?.min} max={field.validation?.max} minLength={field.validation?.minLength} maxLength={field.validation?.maxLength} pattern={field.validation?.pattern} inputMode={field.type === "otp" || field.type === "phone" || field.type === "number" ? "numeric" : undefined} autoComplete={field.type === "otp" ? "one-time-code" : field.type === "secure_password" ? "current-password" : "off"} onChange={(event) => setFieldValue(field.id, event.target.value)} /></label>;
          })}
        </div>

        {isSecure ? <p className="mt-3 rounded-xl border border-cyan-300/15 bg-cyan-400/[0.04] p-3 text-xs leading-5 text-cyan-50/80">Secure values are handled through the protected workflow channel and are not added to the visible chat response.</p> : null}
        {error ? <p className="mt-3 flex items-start gap-2 rounded-xl border border-rose-400/20 bg-rose-500/10 p-3 text-xs text-rose-200"><AlertTriangle className="mt-0.5 shrink-0" size={15} />{error}</p> : null}
        {status === "sending" ? <div className="mt-3 flex items-center gap-2 text-xs text-cyan-100" aria-live="polite"><LoaderCircle className="animate-spin" size={15} />Saving this step and preparing the next requirement…</div> : null}

        {interaction.actions.length ? <div className="mt-4 flex flex-wrap gap-2">{interaction.actions.filter((action) => action !== "undo").map((action) => {
          const primary = action === "submit" || action === "confirm" || action === "authenticate";
          return <button key={action} type="button" disabled={status === "sending"} onClick={() => void (action === "authenticate" ? authenticate() : act(action as Decision))} className={primary ? "inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-3.5 py-2.5 text-xs font-semibold text-slate-950 disabled:opacity-50" : "inline-flex items-center gap-2 rounded-xl border border-white/15 px-3.5 py-2.5 text-xs font-medium text-white disabled:opacity-50"}>{actionIcon(action, status === "sending")}{actionLabel(action)}</button>;
        })}</div> : null}
      </div>
    </section>
  );
}
