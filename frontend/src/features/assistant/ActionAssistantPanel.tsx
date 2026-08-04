import { CheckCircle2, CircleAlert, Clock3, LoaderCircle, ShieldCheck, XCircle } from "lucide-react";
import type { AssistantActionItem, AssistantResponse } from "./types";

function preview(action: AssistantActionItem) {
  const alarm = action.result.alarm as Record<string, unknown> | undefined;
  const time = String(alarm?.scheduled_at || action.arguments.scheduled_at || "");
  const title = String(alarm?.title || action.arguments.label || action.arguments.title || action.arguments.target || "");
  if (time) return `${title || "Alarm"} • ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(time))}`;
  if (action.tool_name === "alarm.list") return `${Array.isArray(action.result.alarms) ? action.result.alarms.length : 0} alarms found`;
  return title || action.tool_name.replace(".", " · ");
}

export function ActionAssistantPanel({ command, response, processing, onConfirm, onCancel, onRetry }: { command: string; response: AssistantResponse | null; processing: boolean; onConfirm: (action: AssistantActionItem) => void; onCancel: (action: AssistantActionItem) => void; onRetry: () => void }) {
  if (!command) return null;
  return <section className="mx-auto mb-3 w-full max-w-3xl rounded-2xl border border-cyan-300/20 bg-slate-950/75 p-4 shadow-xl" aria-live="polite">
    <div className="flex items-start gap-3"><div className="mt-0.5 rounded-lg bg-cyan-400/10 p-2 text-cyan-300">{processing ? <LoaderCircle className="animate-spin" size={18} /> : <ShieldCheck size={18} />}</div><div className="min-w-0 flex-1"><p className="text-xs font-semibold uppercase tracking-wide text-cyan-300">{processing ? "Understanding" : "Action Assistant"}</p><p className="mt-1 text-sm text-slate-200">आपकी बात समझी गई: “{response?.normalized_user_text || command}”</p>{response && <p className="mt-2 text-sm text-white">{response.clarification_question || response.assistant_reply}</p>}</div></div>
    {response?.actions.map((action) => <article key={action.id} className="mt-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-white">{action.status === "completed" ? <CheckCircle2 className="text-emerald-400" size={17} /> : action.status === "failed" ? <CircleAlert className="text-rose-400" size={17} /> : action.status === "cancelled" ? <XCircle className="text-slate-400" size={17} /> : <Clock3 className="text-amber-300" size={17} />}<span>{action.tool_name.replace(".", " · ")}</span><span className="ml-auto text-[10px] uppercase text-slate-400">{action.status.replace("_", " ")}</span></div>
      <p className="mt-2 text-xs text-slate-300">{preview(action)}</p><p className="mt-1 text-xs text-slate-400">{action.message}</p>
      {action.status === "waiting_confirmation" && <div className="mt-3 flex gap-2"><button className="btn-primary min-h-8 px-3 text-xs" type="button" onClick={() => onConfirm(action)}>Confirm</button><button className="btn-secondary min-h-8 px-3 text-xs" type="button" onClick={() => onCancel(action)}>Cancel</button></div>}
      {action.status === "failed" && <button className="btn-secondary mt-3 min-h-8 px-3 text-xs" type="button" onClick={onRetry}>Retry</button>}
    </article>)}
  </section>;
}
