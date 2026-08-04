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
  const visibleTask = activity.visibleTasks[0];

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
            {activity.stage || subtitle || "Crafting a response with the current context."}
          </p>
        </div>
      </div>
      {visibleTask && (
        <div className="thinking-live-activity relative z-10">
          <div className="thinking-live-model">
            <span className={`thinking-live-status is-${visibleTask.status || "queued"}`}>
              {visibleTask.status === "working" ? "Working" : "Queued"}
            </span>
            <strong>{visibleTask.model_display_name || visibleTask.actual_model_id || "Intelligence model"}</strong>
            {visibleTask.provider_display_name && <span>{visibleTask.provider_display_name}</span>}
          </div>
          <p>{visibleTask.activity_label || visibleTask.role || "Processing your request"}</p>
          <div className="thinking-live-progress">
            <span
              style={{
                width: `${activity.tasks.length ? Math.max(4, (activity.completed / activity.tasks.length) * 100) : 4}%`
              }}
            />
          </div>
          <small>
            {activity.completed} of {activity.tasks.length} completed
            {activity.working > 0 ? ` · ${activity.working} working now` : ""}
          </small>
        </div>
      )}
    </div>
  );
}
