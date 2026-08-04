// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { api } from "../../api/client";
import type { IntentInteraction } from "../../types";
import { DynamicInteractionCard } from "./DynamicInteractionCard";


afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function informationInteraction(title: string, fieldId: string, fieldLabel: string): IntentInteraction {
  return {
    type: "information_request",
    title,
    description: "Provide the next required detail.",
    fields: [
      {
        id: fieldId,
        type: "text",
        label: fieldLabel,
        required: true,
        options: []
      }
    ],
    actions: ["submit", "cancel"],
    workflow_id: "workflow-1"
  };
}

describe("DynamicInteractionCard", () => {
  it("does not display a saved state before the user submits a valid value", () => {
    render(<DynamicInteractionCard interaction={informationInteraction("Applicant details", "name", "Applicant name")} token="token" />);

    expect(screen.queryByText(/saved/i)).toBeNull();
    expect(screen.getByLabelText(/Applicant name/)).toBeTruthy();
  });

  it("blocks an empty required step instead of falsely marking it saved", () => {
    render(<DynamicInteractionCard interaction={informationInteraction("Applicant details", "name", "Applicant name")} token="token" />);

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(screen.getByText(/Complete Applicant name/)).toBeTruthy();
    expect(screen.queryByText("Step completed")).toBeNull();
  });

  it("shows completion only after the backend confirms persistence", async () => {
    vi.spyOn(api, "submitIntentInteraction").mockResolvedValue({ workflow_id: "workflow-1", state: "REQUIREMENTS_ANALYSIS" });
    render(<DynamicInteractionCard interaction={informationInteraction("Applicant details", "name", "Applicant name")} token="token" />);

    fireEvent.change(screen.getByLabelText(/Applicant name/), { target: { value: "Shyam Raj" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(api.submitIntentInteraction).toHaveBeenCalledWith("token", "workflow-1", { values: { name: "Shyam Raj" }, decision: "submit" }));
    expect(await screen.findByText("Step completed")).toBeTruthy();
  });

  it("resets a completed card when the workflow advances to a different interaction", async () => {
    vi.spyOn(api, "submitIntentInteraction").mockResolvedValue({ workflow_id: "workflow-1", state: "REQUIREMENTS_ANALYSIS" });
    const first = informationInteraction("Applicant details", "name", "Applicant name");
    const second = informationInteraction("Address details", "district", "District");
    const view = render(<DynamicInteractionCard interaction={first} token="token" />);

    fireEvent.change(screen.getByLabelText(/Applicant name/), { target: { value: "Shyam Raj" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(await screen.findByText("Step completed")).toBeTruthy();

    view.rerender(<DynamicInteractionCard interaction={second} token="token" />);

    expect(screen.queryByText("Step completed")).toBeNull();
    expect(screen.getByLabelText(/District/)).toBeTruthy();
    expect((screen.getByLabelText(/District/) as HTMLInputElement).value).toBe("");
  });
});
