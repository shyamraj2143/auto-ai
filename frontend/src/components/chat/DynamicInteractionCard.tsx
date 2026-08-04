import { useState } from "react";
import { AlertTriangle, CheckCircle2, LockKeyhole } from "lucide-react";
import { api } from "../../api/client";
import type { IntentInteraction } from "../../types";

const supported = new Set(["text","email","phone","number","date","time","address","select","multiselect","radio","checkbox","textarea","file","camera","pdf","image","signature","secure_password","otp","captcha","biometric","permission","review","confirmation","progress","receipt"]);

export function DynamicInteractionCard({ interaction, token }: { interaction: IntentInteraction; token?: string | null }) {
  const [values,setValues]=useState<Record<string,unknown>>({});
  const [status,setStatus]=useState<"idle"|"sending"|"complete"|"error">("idle");
  const [error,setError]=useState("");
  const [completion,setCompletion]=useState("");
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
  async function act(decision: "submit"|"confirm"|"cancel"|"retry"|"pause") {
    if (!token || !interaction.workflow_id) return;
    if ((decision === "submit" || decision === "confirm") && !validateRequiredFields()) return;
    setStatus("sending");setError("");
    try {
      const result = await api.submitIntentInteraction(token,interaction.workflow_id,{values,decision});
      if (!result.workflow_id || !result.state) throw new Error("The workflow did not confirm persistence.");
      setCompletion(decision === "cancel" ? "Workflow cancelled." : `${interaction.title} submitted and persisted. Current workflow state: ${result.state.replace(/_/g, " ").toLowerCase()}.`);
      setStatus("complete");
    }
    catch (cause) { setError(cause instanceof Error?cause.message:"Unable to continue workflow");setStatus("error"); }
  }
  async function authenticate() {
    if (!token || !interaction.workflow_id) return;
    const secret=String(values.secret||"");
    if(!secret){setError("Enter the secure value.");return;}
    setStatus("sending");setError("");
    try {
      const challenge=await api.createSecureChallenge(token,interaction.workflow_id,"otp");
      const result=await api.submitSecureChallenge(token,challenge.id,secret);
      if (!result.workflow_id || !result.status) throw new Error("The secure workflow did not confirm persistence.");
      setValues({});setCompletion("Secure verification accepted for this active workflow.");setStatus("complete");
    }
    catch(cause){setValues({});setError(cause instanceof Error?cause.message:"Secure verification failed");setStatus("error");}
  }
  if (status==="complete") return <section className="not-prose rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4" aria-live="polite"><span className="flex items-center gap-2"><CheckCircle2 size={17}/>{completion}</span></section>;
  return <section className="not-prose rounded-xl border border-cyan-300/20 bg-slate-950/60 p-4" aria-label={interaction.title}>
    <header className="mb-3"><h3 className="flex items-center gap-2 text-sm font-semibold text-white">{interaction.type==="secure_input"?<LockKeyhole size={16}/>:null}{interaction.title}</h3>{interaction.description?<p className="mt-1 text-xs leading-5 text-slate-300">{interaction.description}</p>:null}</header>
    <div className="grid gap-3">{interaction.fields.map(field=>{
      if(!supported.has(field.type)) return null;
      const common={id:`intent-${field.id}`,required:field.required,"aria-label":field.label,className:"w-full rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm text-white",onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>)=>setValues(current=>({...current,[field.id]:event.target.type==="checkbox"?(event.target as HTMLInputElement).checked:event.target.value}))};
      return <label key={field.id} className="grid gap-1 text-xs text-slate-200"><span>{field.label}{field.required?" *":""}</span>{field.type==="textarea"?<textarea {...common}/>:field.type==="select"?<select {...common}><option value="">Select</option>{field.options.map(option=><option key={option}>{option}</option>)}</select>:field.type==="permission"?<input {...common} type="checkbox"/>:<input {...common} type={field.type==="secure_password"?"password":field.type==="otp"?"password":["email","number","date","time","file"].includes(field.type)?field.type:"text"} autoComplete={field.type==="otp"?"one-time-code":field.type==="secure_password"?"current-password":"off"}/>}</label>
    })}</div>
    {error?<p className="mt-3 flex items-center gap-2 text-xs text-rose-300"><AlertTriangle size={14}/>{error}</p>:null}
    <div className="mt-4 flex flex-wrap gap-2">{interaction.actions.filter(action=>action!=="undo").map(action=><button key={action} type="button" disabled={status==="sending"} onClick={()=>void (action==="authenticate"?authenticate():act(action==="retry"?"retry":action))} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{action.replace("_"," ")}</button>)}</div>
  </section>;
}
