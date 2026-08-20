import { describe, expect, it } from "vitest";
import type { OrchestrationActivityEvent } from "../../types";
import { modelActivityCards } from "./LiveModelActivity";
import { thinkingActivitySnapshot } from "./ThinkingIndicator";

function event(sequence: number, type: string, status: OrchestrationActivityEvent["status"], extra = {}) {
  return {
    sequence,
    event: type,
    request_id: "request-1",
    task_id: "task-1",
    model_display_name: "GPT-OSS 120B",
    provider_display_name: "Groq",
    role: "Primary solution generator",
    activity_label: "Preparing the primary answer",
    status,
    ...extra
  } satisfies OrchestrationActivityEvent;
}

describe("live model activity", () => {
  it("updates one card across queued, working, retry and completion events", () => {
    const cards = modelActivityCards([
      event(1, "model.queued", "queued"),
      event(2, "model.started", "working"),
      event(3, "model.started", "working"),
      event(4, "model.completed", "completed", { contributed_to_final_answer: true })
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "completed", contributed_to_final_answer: true });
  });

  it("does not display models that have no backend execution event", () => {
    const cards = modelActivityCards([event(1, "task.created", undefined)]);
    expect(cards).toHaveLength(0);
  });

  it("never leaves a failed task working", () => {
    const cards = modelActivityCards([
      event(1, "model.started", "working"),
      event(2, "model.failed", "failed")
    ]);
    expect(cards[0]?.status).toBe("failed");
  });

  it("reports the models currently working and overall progress in the thinking banner", () => {
    const snapshot = thinkingActivitySnapshot([
      event(1, "model.queued", "queued"),
      event(2, "model.started", "working"),
      {
        ...event(3, "model.completed", "completed"),
        task_id: "task-2",
        model_display_name: "Claude 3.7 Sonnet",
      },
      event(4, "stage.started", undefined, { task_id: undefined, stage: "Comparing model findings" })
    ]);

    expect(snapshot.visibleTasks).toHaveLength(1);
    expect(snapshot.visibleTasks[0]).toMatchObject({
      model_display_name: "GPT-OSS 120B",
      provider_display_name: "Groq",
      activity_label: "Preparing the primary answer"
    });
    expect(snapshot).toMatchObject({
      completed: 1,
      working: 1,
      stage: "Comparing model findings"
    });
  });
});
