// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { SevaAssistancePanel } from "./SevaAssistancePanel";
import { sevaApi, type SevaWorkOrder } from "./sevaApi";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function assignedWorkOrder(): SevaWorkOrder {
  return {
    id: "work-1",
    case_id: "SEVA-2026-ABC123",
    task_id: "task-1",
    handoff_id: "handoff-1",
    status: "IN_PROGRESS",
    priority: "NORMAL",
    request_summary: "Income certificate",
    employee_note: null,
    assigned_employee: { id: "agent-user-1", name: "Seva Agent" },
    service: { id: "service-1", name: "Income Certificate", provider: "Government of Bihar" },
    task_progress: 45,
    work_progress: 15,
    current_activity: "Assigned to a Seva agent",
    reference_number: null,
    submitted_at: "2026-08-09T09:00:00Z",
    due_at: "2026-08-16T09:00:00Z",
    queue_position: null,
    consent_scope: { authentication_secrets_shared: false },
    requirements: [],
    deliverables: [],
    timeline: [],
    created_at: "2026-08-09T09:00:00Z",
    updated_at: "2026-08-09T09:00:00Z",
  };
}

describe("SevaAssistancePanel", () => {
  it("automatically dispatches a submitted form without rendering a second request form", async () => {
    vi.spyOn(sevaApi, "getAssistance").mockResolvedValue({ work_order: null });
    vi.spyOn(sevaApi, "requestAssistance").mockResolvedValue(assignedWorkOrder());
    vi.spyOn(sevaApi, "listNotifications").mockResolvedValue({ items: [], unread: 0 });

    render(<SevaAssistancePanel token="token" taskId="task-1" autoAssign />);

    await waitFor(() => expect(sevaApi.requestAssistance).toHaveBeenCalledWith("token", "task-1", "Process this submitted application and provide the final acknowledgement or receipt."));
    expect(screen.queryByText("Purpose")).toBeNull();
    expect(screen.queryByRole("button", { name: /Request employee help/i })).toBeNull();
    expect(await screen.findByText("SEVA-2026-ABC123")).toBeTruthy();
  });
});
