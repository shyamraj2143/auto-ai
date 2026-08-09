// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { api } from "../../api/client";
import type { ServiceCardType, ServiceTaskState, ServiceTaskView } from "../../types";
import { ServiceTaskCard } from "./ServiceTaskCard";


afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

function task(type: ServiceCardType, state: ServiceTaskState, data: Record<string, unknown>, actions: string[] = []): ServiceTaskView {
  return {
    id: "task-1",
    chat_id: "chat-1",
    service_id: "autoai.safe-test-form",
    service_name: "AutoAI Safe Test Form",
    provider: "AutoAI",
    state,
    execution_mode: "EXECUTE_WITH_CONFIRMATION",
    progress_percent: 50,
    version: 4,
    created_at: "2026-08-04T10:00:00Z",
    updated_at: "2026-08-04T10:00:00Z",
    active_card: { type, title: "Service step", description: "Complete this step.", state, status: "active", task_id: "task-1", task_version: 4, progress_percent: 50, execution_mode: "EXECUTE_WITH_CONFIRMATION", data, actions, updated_at: "2026-08-04T10:00:00Z" }
  };
}

describe("ServiceTaskCard", () => {
  it("renders an accessible persisted service plan and starts it", async () => {
    const plan = task("service_plan", "CREATED", { service: "AutoAI Safe Test Form", provider: "AutoAI", estimated_steps: 6, official_origin: null, mode_notice: "Safe test service", requirements: ["Applicant name"] }, ["start", "cancel"]);
    const next = task("information_request", "COLLECTING_INFORMATION", { data_request_id: "request-1", fields: [], saved_values: {} }, ["save_fields"]);
    vi.spyOn(api, "startServiceTask").mockResolvedValue(next);
    render(<ServiceTaskCard task={plan} token="token" />);
    expect(screen.getByRole("region", { name: "Service step" }).textContent).toContain("Safe test service");
    fireEvent.click(screen.getByRole("button", { name: "Start application" }));
    await waitFor(() => expect(api.startServiceTask).toHaveBeenCalledWith("token", "task-1", 4));
  });

  it("submits short validated information groups as typed values", async () => {
    const information = task("information_request", "COLLECTING_INFORMATION", { data_request_id: "request-1", saved_values: {}, fields: [{ key: "email", label: "Email", type: "email", required: true, explanation: "Used for this application." }] }, ["save_fields"]);
    const next = task("task_progress", "READY_TO_PREPARE", { steps: [] }, ["prepare"]);
    vi.spyOn(api, "saveServiceFields").mockResolvedValue(next);
    render(<ServiceTaskCard task={information} token="token" />);
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "asha@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(api.saveServiceFields).toHaveBeenCalledWith("token", "task-1", 4, "request-1", { email: "asha@example.test" }));
  });

  it("submits only the active field chunk when earlier fields are already saved", async () => {
    const information = task("information_request", "COLLECTING_INFORMATION", { data_request_id: "request-2", total_required_fields: 7, saved_values: { applicant_name: "Asha Kumari", father_name: "Ramesh Kumar", date_of_birth: "2000-01-02", district: "Patna" }, fields: [{ key: "block", label: "Block", type: "text", required: true }] }, ["save_fields"]);
    const next = task("task_progress", "READY_TO_PREPARE", { steps: [] }, ["prepare"]);
    vi.spyOn(api, "saveServiceFields").mockResolvedValue(next);
    render(<ServiceTaskCard task={information} token="token" />);
    fireEvent.change(screen.getByLabelText(/Block/), { target: { value: "Phulwari" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("5/7 required fields completed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(api.saveServiceFields).toHaveBeenCalledWith("token", "task-1", 4, "request-2", { block: "Phulwari" }));
  });

  it("uses the integrated RTPS declaration before submitting an assisted application", async () => {
    const information = task("information_request", "COLLECTING_INFORMATION", { data_request_id: "request-1", saved_values: {}, fields: [{ key: "applicant_name", label: "Applicant name / आवेदक का नाम", type: "text", required: true }] }, ["save_fields"]);
    information.execution_mode = "ASSIST";
    information.active_card.execution_mode = "ASSIST";
    const next = task("task_progress", "READY_TO_PREPARE", { steps: [] }, ["prepare"]);
    vi.spyOn(api, "saveServiceFields").mockResolvedValue(next);
    render(<ServiceTaskCard task={information} token="token" />);

    expect(screen.getAllByText("आवेदक का विवरण / Applicant Details").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/Applicant name/), { target: { value: "Asha Kumari" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const submit = screen.getByRole("button", { name: "Submit application / आवेदन जमा करें" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText(/authorize AutoAI Seva to assign/i));
    fireEvent.click(submit);
    await waitFor(() => expect(api.saveServiceFields).toHaveBeenCalledWith("token", "task-1", 4, "request-1", { applicant_name: "Asha Kumari" }));
  });

  it("restores only non-secret offline draft fields after remount", () => {
    const information = task("information_request", "COLLECTING_INFORMATION", { data_request_id: "request-1", saved_values: {}, fields: [{ key: "district", label: "District", type: "text", required: true }] }, ["save_fields"]);
    const first = render(<ServiceTaskCard task={information} token="token" />);
    fireEvent.change(screen.getByLabelText(/District/), { target: { value: "Patna" } });
    first.unmount();
    render(<ServiceTaskCard task={information} token="token" />);
    expect((screen.getByLabelText(/District/) as HTMLInputElement).value).toBe("Patna");
  });

  it("clears an ephemeral OTP immediately and never renders it as chat content", async () => {
    const secure = task("secure_input_request", "AWAITING_AUTHENTICATION", { challenge_id: "challenge-1", kind: "otp", official_origin: "https://autoai.site.je", secure_channel_supported: true }, ["submit_secure"]);
    const next = task("form_review", "REVIEW_REQUIRED", { summary: {}, documents: [], fee: {} }, ["confirm_information"]);
    vi.spyOn(api, "submitServiceSecureResponse").mockResolvedValue(next);
    render(<ServiceTaskCard task={secure} token="token" />);
    const input = screen.getByLabelText("One-time code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "654321" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.value).toBe("");
    await waitFor(() => expect(api.submitServiceSecureResponse).toHaveBeenCalledWith("token", "task-1", "challenge-1", "654321"));
    expect(screen.queryByText("654321")).toBeNull();
  });

  it("labels user-reported outcomes as unverified instead of success", () => {
    const receipt = task("action_receipt", "SUBMITTED_UNVERIFIED", { status: "submitted but unverified", application_id: "USER-REF-1", evidence: [] }, ["verify", "recovery"]);
    render(<ServiceTaskCard task={receipt} token="token" />);
    expect(screen.getAllByText(/unverified/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/successfully submitted/i)).toBeNull();
  });

  it("shows verified success and a backend-derived read-only tracker", () => {
    const receipt = task("action_receipt", "COMPLETED_VERIFIED", { status: "verified", application_id: "AUTOAI-TEST-1", submission_timestamp: "2026-08-04T10:00:00Z", last_updated: "2026-08-04T10:02:00Z", status_timeline: [{ key: "started", label: "Application started / आवेदन शुरू", status: "completed", timestamp: "2026-08-04T09:55:00Z" }, { key: "completed", label: "Completed / पूर्ण", status: "completed", timestamp: "2026-08-04T10:02:00Z" }], evidence: [{ type: "portal_receipt", verified: true }] }, ["track", "view_receipt"]);
    render(<ServiceTaskCard task={receipt} token="token" />);
    expect(screen.getByText("Application submitted successfully")).toBeTruthy();
    expect(screen.getByRole("button", { name: "OK, Done" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Track Status" }));
    expect(screen.getByRole("region", { name: "Application status tracker" }).textContent).toContain("Completed / पूर्ण");
  });

  it("records a guided portal result as user-reported instead of verified success", async () => {
    const portal = task("portal_session", "PORTAL_SESSION_ACTIVE", { official_origin: "https://ors.gov.in", entry_url: "https://ors.gov.in/", current_step: "Continue guided completion" }, ["open_portal"]);
    const unverified = task("action_receipt", "SUBMITTED_UNVERIFIED", { status: "submitted but unverified", application_id: "USER-REF-1", evidence: [] }, ["retry_verification"]);
    vi.spyOn(api, "reportServicePortalOutcome").mockResolvedValue(unverified);
    render(<ServiceTaskCard task={portal} token="token" />);
    fireEvent.click(screen.getByRole("button", { name: "Report portal result" }));
    fireEvent.change(screen.getByLabelText("Application ID (optional)"), { target: { value: "USER-REF-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Report submitted" }));
    await waitFor(() => expect(api.reportServicePortalOutcome).toHaveBeenCalledWith("token", "task-1", 4, "submitted", "USER-REF-1", ""));
    expect(await screen.findByText("submitted but unverified")).toBeTruthy();
  });

  it("creates a least-data handoff only after explicit field selection", async () => {
    const portal = task("portal_session", "PORTAL_SESSION_ACTIVE", { official_origin: "https://ors.gov.in", shareable_fields: [{ key: "patient_name", label: "Patient name" }], shareable_documents: [] }, ["human_help"]);
    vi.spyOn(api, "requestServiceHandoff").mockResolvedValue({ id: "handoff-1", status: "APPROVED" });
    vi.spyOn(api, "getServiceTask").mockResolvedValue(portal);
    render(<ServiceTaskCard task={portal} token="token" />);
    fireEvent.click(screen.getByRole("button", { name: "Human assistance" }));
    fireEvent.click(screen.getByLabelText("Patient name"));
    fireEvent.click(screen.getByRole("button", { name: "Approve handoff request" }));
    await waitFor(() => expect(api.requestServiceHandoff).toHaveBeenCalledWith("token", "task-1", 4, ["patient_name"], [], "Help me complete this service safely"));
    expect(await screen.findByText(/No agent has been assigned yet/)).toBeTruthy();
  });

  it("runs optional document OCR only after explicit cloud-processing consent", async () => {
    const documentTask = task("document_request", "COLLECTING_DOCUMENTS", { requirements: [{ id: "requirement-1", key: "photo", label: "Photo", accepted_mime_types: ["image/png"], max_bytes: 2048, required: true, status: "VALID" }], documents: [{ id: "asset-1", requirement_id: "requirement-1", label: "Photo", filename: "photo.png", content_type: "image/png", file_size: 100, validation_status: "VALID", ocr_status: "AVAILABLE_ON_REQUEST", extracted_fields: {} }] }, ["upload_file"]);
    const next = task("document_request", "COLLECTING_DOCUMENTS", { requirements: [], documents: [] }, []);
    vi.spyOn(api, "runServiceDocumentOcr").mockResolvedValue(next);
    render(<ServiceTaskCard task={documentTask} token="token" />);
    const button = screen.getByRole("button", { name: "Run document OCR" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByLabelText("I consent to cloud OCR for this document"));
    fireEvent.click(button);
    await waitFor(() => expect(api.runServiceDocumentOcr).toHaveBeenCalledWith("token", "task-1", 4, "asset-1"));
  });
});
