import { AnimatePresence, motion } from "../../motion/staticMotion";
import { useMemo } from "react";
import { NeuralCore } from "../../motion/NeuralCore";
import type { ChatGeneration, OrchestrationActivityEvent } from "../../types";
import { modelActivityCards } from "./LiveModelActivity";

export function thinkingActivitySnapshot(events: OrchestrationActivityEvent[]) {
  const tasks = modelActivityCards(events);
  const working = tasks.filter((task) => task.status === "working");
  const queued = tasks.filter((task) => task.status === "queued");
  return {
    tasks,
    visibleTasks: working.length ? working : queued,
    completed: tasks.filter((task) => task.status === "completed").length,
    working: working.length,
    stage: [...events].reverse().find((event) => event.stage)?.stage
  };
}

export function ThinkingIndicator({
  label,
  subtitle,
  generation
}: {
  label?: string;
  subtitle?: string;
  generation?: ChatGeneration | null;
} = {}) {
  const displayLabel = label || "Thinking";
  const activity = useMemo(
    () => thinkingActivitySnapshot(generation?.activity ?? []),
    [generation?.activity]
  );
  const visibleTasks = activity.visibleTasks.slice(0, 3);

  return (
    <div className="thinking-panel" aria-live="polite">
      <div className="neural-field" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="relative z-10 flex min-w-0 items-center gap-3">
        <NeuralCore className="thinking-core neural-core-chat" state="thinking" size="sm" />
        <div className="min-w-0 flex-1">
          <AnimatePresence mode="wait">
            <motion.p
              key={displayLabel}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28 }}
              className="truncate text-sm font-medium text-slate-100"
            >
              {displayLabel}
              <span className="morphing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </motion.p>
          </AnimatePresence>
          <p className="mt-1 text-xs text-slate-300/80">
            {activity.stage || subtitle || "Reasoning through the request and comparing available models."}
          </p>
        </div>
      </div>

      {visibleTasks.length > 0 && (
        <div className="thinking-live-activity relative z-10">
          {visibleTasks.map((task) => (
            <div className="thinking-live-model" key={task.task_id}>
              <span className={`thinking-live-status is-${task.status || "queued"}`}>
                {task.status === "working" ? "Working" : "Queued"}
              </span>
              <strong>{task.model_display_name || task.actual_model_id || "Intelligence model"}</strong>
              {task.provider_display_name && <span>{task.provider_display_name}</span>}
            </div>
          ))}
          <p>
            {activity.completed} of {activity.tasks.length} model requests completed
            {activity.working > 0 ? ` · ${activity.working} running in parallel` : ""}
          </p>
          <div className="thinking-live-progress" role="progressbar" aria-valuemin={0} aria-valuemax={activity.tasks.length} aria-valuenow={activity.completed}>
            <span
              style={{
                width: `${activity.tasks.length ? Math.max(4, (activity.completed / activity.tasks.length) * 100) : 4}%`
              }}
            />
          </div>
          <small>
            AutoAI is comparing specialist outputs and will synthesize the final answer after the useful responses arrive.
          </small>
        </div>
      )}
    </div>
  );
}
