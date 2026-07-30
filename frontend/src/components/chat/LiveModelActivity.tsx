import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, Clock3, Square, TriangleAlert, X } from "lucide-react";
import clsx from "clsx";
import type { ChatGeneration, OrchestrationActivityEvent } from "../../types";

const MODE_LABELS: Record<string, string> = {
  instant: "Instant Intelligence",
  medium: "Medium Intelligence",
  high: "High Intelligence",
  deep_research: "Deep Research"
};

export function modelActivityCards(events: OrchestrationActivityEvent[]) {
  const cards = new Map<string, OrchestrationActivityEvent>();
  events.forEach((event) => {
    if (event.task_id && event.event.startsWith("model.")) {
      cards.set(event.task_id, { ...cards.get(event.task_id), ...event });
    }
  });
  return [...cards.values()];
}

function statusIcon(status?: string) {
  if (status === "completed") return <Check size={14} />;
  if (status === "failed" || status === "timed_out") return <TriangleAlert size={14} />;
  if (status === "cancelled") return <X size={14} />;
  return <Circle size={11} fill="currentColor" />;
}

export function LiveModelActivity({
  generation,
  running,
  onCancel
}: {
  generation: ChatGeneration;
  running: boolean;
  onCancel: () => void;
}) {
  const [expanded, setExpanded] = useState(running);
  const [now, setNow] = useState(Date.now());
  const events = generation.activity ?? [];
  const tasks = useMemo(() => modelActivityCards(events), [events]);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "working").length;
  const lastEvent = events[events.length - 1];
  const stage = lastEvent?.stage || lastEvent?.activity_label || (running ? "Understanding your request" : "Response ready");
  const startedAt = Date.parse(events[0]?.occurred_at || generation.created_at);
  const elapsedMs = generation.activity_summary?.duration_ms ?? Math.max(0, now - startedAt);
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
  const contributed = generation.activity_summary?.models_contributed ?? completed;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);

  return (
    <section className={clsx("model-activity-panel", !running && "model-activity-complete")} aria-live="polite">
      <div className="model-activity-header">
        <button
          className="model-activity-toggle"
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={`model-activity-${generation.id}`}
        >
          <span className="model-activity-title">
            {running ? "AutoAI Intelligence is working" : `Response prepared using ${contributed} intelligence model${contributed === 1 ? "" : "s"}`}
          </span>
          <span className="model-activity-subtitle">
            {MODE_LABELS[generation.mode || "instant"] || "AutoAI Intelligence"} · {completed} of {tasks.length} tasks completed · {elapsed}
          </span>
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {running && (
          <button className="model-activity-cancel" type="button" onClick={onCancel} aria-label="Cancel generation">
            <Square size={13} /> Cancel
          </button>
        )}
      </div>
      <div className="model-activity-stage">
        {running && <span className="generation-dot" aria-hidden="true" />}
        <span>{stage}</span>
        {active > 0 && <span>{active} active</span>}
      </div>
      {expanded && (
        <div id={`model-activity-${generation.id}`} className="model-activity-body">
          {tasks.map((task) => (
            <article key={task.task_id} className={clsx("model-activity-card", `is-${task.status || "queued"}`)}>
              <div className="model-activity-card-title">
                <span className="model-activity-status-icon">{statusIcon(task.status)}</span>
                <strong>{task.model_display_name}</strong>
                <span>{task.status?.replace("_", " ")}</span>
              </div>
              <dl>
                <div><dt>Provider</dt><dd>{task.provider_display_name}</dd></div>
                <div><dt>Role</dt><dd>{task.role}</dd></div>
                <div><dt>Activity</dt><dd>{task.activity_label}</dd></div>
                {typeof task.duration_ms === "number" && (
                  <div><dt><Clock3 size={12} /> Time</dt><dd>{(task.duration_ms / 1000).toFixed(1)}s</dd></div>
                )}
              </dl>
              {task.contributed_to_final_answer && <span className="model-contributed-badge">Used in final answer</span>}
            </article>
          ))}
          {!tasks.length && running && <div className="model-activity-empty">Preparing intelligence tasks…</div>}
          {!running && generation.activity_summary?.fallback_used && (
            <div className="model-activity-fallback">Continued with available intelligence models.</div>
          )}
          {!running && generation.mode === "deep_research" && (
            <div className="model-activity-sources">Verified sources: {generation.activity_summary?.verified_sources ?? 0}</div>
          )}
        </div>
      )}
    </section>
  );
}
