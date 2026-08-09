// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sevaApi, type SevaService } from "./sevaApi";
import { SevaSearchPanel } from "./SevaSearchPanel";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const service: SevaService = {
  id: "bihar.income-certificate", version: "2026.08", name: "Bihar Income Certificate",
  provider: "Government of Bihar", authority: "Government of Bihar", category: "government",
  department: "General Administration", country: "IN", region: "Bihar", verified: true, confidence: .97,
  description: "Prepare an income-certificate application.", who_can_apply: "Eligible Bihar applicants",
  application_mode: "Guided completion", processing_information: "Authority dependent",
  expected_timeline: "Official portal timeline", fee: { label: "Confirm on official portal" }, eligibility: [], fields: [],
  documents: [{ key: "identity", label: "Identity proof", required: true }], execution_modes: ["ASSIST"],
  authentication_type: "portal_session", tracking_method: "application_reference", protected_actions: ["OTP"],
  warnings: [], official_source: "https://serviceonline.bihar.gov.in/", is_official_portal: false,
  disclaimer: "AutoAI is not a government portal.",
};

describe("SevaSearchPanel", () => {
  it("discovers candidates without creating a task and requires explicit confirmation", async () => {
    vi.spyOn(sevaApi, "discoverServices").mockResolvedValue({ query: "income certificate", requires_confirmation: true, candidates: [service] });
    const selected = vi.fn();
    render(<SevaSearchPanel token="token" onServiceSelected={selected} />);
    fireEvent.change(screen.getByPlaceholderText(/income certificate/i), { target: { value: "income certificate" } });
    fireEvent.click(screen.getByRole("button", { name: "Find services" }));
    await waitFor(() => expect(sevaApi.discoverServices).toHaveBeenCalledWith("token", "income certificate"));
    expect(screen.getByText("Bihar Income Certificate")).toBeTruthy();
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /View details and confirm/i }));
    expect(selected).toHaveBeenCalledWith(service, "income certificate");
  });
});
