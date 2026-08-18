import { useEffect, useState } from "react";
import { readStoredSession } from "../../auth/sessionStorage";

type Snapshot = {
  model_name: string; status: string; enabled: boolean; training_samples: number; memory_count: number;
  conversation_turns: number; feedback_count: number; positive_feedback: number; quality_score: number;
  learning_version: number; last_trained_at?: string | null; learning_style?: string | null;
  favorite_topics?: string[]; current_projects?: string[]; long_term_objectives?: string[];
  preferred_models?: string[];
  memories?: Array<{ id: string; category: string; key: string; value: string; confidence: number }>;
};

const API_BASE = (window.__AUTO_AI_API_URL__ || "https://autoai.site.je/api/v1").replace(/\/$/, "");

async function request(path: string, options: RequestInit = {}) {
  const session = await readStoredSession();
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (session.accessToken) headers.set("Authorization", `Bearer ${session.accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "Personal Model request failed");
  return body;
}

export function PersonalModelPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [training, setTraining] = useState(false);
  const [error, setError] = useState("");

  const load = async () => setData(await request("/human/personal-model"));
  useEffect(() => { load().catch((e) => setError(e instanceof Error ? e.message : "Unable to load Personal Model")); }, []);

  const train = async () => {
    setTraining(true); setError("");
    try { setData(await request("/human/personal-model/train", { method: "POST" })); }
    catch (e) { setError(e instanceof Error ? e.message : "Training failed"); }
    finally { setTraining(false); }
  };

  if (!data) return <div className="min-h-full p-6 text-sm text-slate-300">{error || "Loading Personal Model…"}</div>;

  return (
    <main className="min-h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-5xl space-y-5">
        <header className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-violet-300">AutoAI Personal Model</p>
              <h1 className="mt-1 text-2xl font-semibold text-white">Your private AI learning layer</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400">AutoAI learns your preferences, useful memories and response feedback without mixing your private data with other users.</p>
            </div>
            <button onClick={train} disabled={training || !data.enabled} className="rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2 text-sm font-medium text-violet-100 disabled:opacity-40">{training ? "Training…" : "Train / Update Model"}</button>
          </div>
          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        </header>
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[["Samples", data.training_samples], ["Memories", data.memory_count], ["Feedback", data.feedback_count], ["Quality", `${Math.round(data.quality_score * 100)}%`]].map(([label, value]) => <div key={String(label)} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-semibold text-white">{value}</p></div>)}
        </section>
        <section className="grid gap-5 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="font-semibold text-white">Learned profile</h2><div className="mt-4 space-y-2 text-sm text-slate-300"><p><span className="text-slate-500">Status:</span> {data.status}</p><p><span className="text-slate-500">Version:</span> {data.model_name} · v{data.learning_version}</p><p><span className="text-slate-500">Learning style:</span> {data.learning_style || "Still learning"}</p><p><span className="text-slate-500">Favorite topics:</span> {(data.favorite_topics || []).join(", ") || "Still learning"}</p><p><span className="text-slate-500">Projects:</span> {(data.current_projects || []).join(", ") || "Still learning"}</p></div></div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="font-semibold text-white">Preferred model signals</h2><div className="mt-4 flex flex-wrap gap-2">{(data.preferred_models || []).map((model) => <span key={model} className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-slate-300">{model}</span>)}</div><p className="mt-4 text-xs text-slate-500">Explicit feedback influences future model selection and response style.</p></div>
        </section>
        <section className="rounded-2xl border border-white/10 bg-white/[0.025] p-5"><h2 className="font-semibold text-white">What AutoAI remembers</h2><div className="mt-4 grid gap-2 md:grid-cols-2">{(data.memories || []).slice(0, 20).map((memory) => <div key={memory.id} className="rounded-xl border border-white/5 bg-black/10 p-3"><p className="text-xs text-violet-300">{memory.category} · {memory.key}</p><p className="mt-1 text-sm text-slate-300">{memory.value}</p></div>)}</div>{!data.memories?.length && <p className="mt-3 text-sm text-slate-500">No durable memories yet. AutoAI will learn from future conversations and explicit feedback.</p>}</section>
      </div>
    </main>
  );
}
