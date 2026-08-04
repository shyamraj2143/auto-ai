// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ServiceTaskView } from "../../types";
import { ServiceTaskCard } from "./ServiceTaskCard";
import { serviceNative } from "./serviceNative";


afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function verifiedTask(): ServiceTaskView {
  return {
    id: "task-print-1",
    chat_id: "chat-1",
    service_id: "bihar.income-certificate",
    service_name: "Bihar Income Certificate",
    provider: "Government of Bihar — ServicePlus",
    state: "COMPLETED_VERIFIED",
    execution_mode: "ASSIST",
    progress_percent: 100,
    version: 8,
    created_at: "2026-08-04T10:00:00Z",
    updated_at: "2026-08-04T10:10:00Z",
    active_card: {
      type: "action_receipt",
      title: "Action receipt",
      description: "Submission is verified.",
      state: "COMPLETED_VERIFIED",
      status: "active",
      task_id: "task-print-1",
      task_version: 8,
      progress_percent: 100,
      execution_mode: "ASSIST",
      actions: ["track", "view_receipt"],
      updated_at: "2026-08-04T10:10:00Z",
      data: {
        status: "verified",
        application_id: "APP-123",
        transaction_id: "TX-456",
        verified_portal: "https://serviceonline.bihar.gov.in",
        submission_timestamp: "2026-08-04T10:09:00Z",
        evidence: [{ type: "portal_confirmation", verified: true }],
        application_preview: {
          portal_name: "RTPS Bihar ServicePlus",
          official_origin: "https://serviceonline.bihar.gov.in",
          current_stage: "Completed",
          fields: [
            { key: "applicant_name", label: "Applicant name", value: "Shyam Raj", source: "user", status: "complete", confidence: "high" },
            { key: "aadhaar_number", label: "Aadhaar number", value: "123456789012", source: "user", status: "complete", confidence: "high" },
            { key: "otp", label: "OTP", value: "654321", source: "secure", status: "complete", confidence: "high" }
          ],
          documents: [{ label: "Residence proof", filename: "residence.pdf", status: "VALID" }]
        }
      }
    }
  };
}

describe("ServiceTaskCard printable application", () => {
  it("opens native or browser print with a complete masked application summary", async () => {
    const print = vi.spyOn(serviceNative, "printHtml").mockResolvedValue();
    render(<ServiceTaskCard task={verifiedTask()} token="token" />);

    fireEvent.click(screen.getByRole("button", { name: "Print application" }));

    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    const [title, html] = print.mock.calls[0];
    expect(title).toContain("Bihar Income Certificate");
    expect(html).toContain("APP-123");
    expect(html).toContain("Shyam Raj");
    expect(html).toContain("9012");
    expect(html).not.toContain("123456789012");
    expect(html).not.toContain("654321");
    expect(html).toContain("Excluded from printable copy");
  });

  it("shows both print and downloadable summary actions for a receipt", () => {
    render(<ServiceTaskCard task={verifiedTask()} token="token" />);

    expect(screen.getByRole("button", { name: "Print application" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download printable summary" })).toBeTruthy();
  });
});
