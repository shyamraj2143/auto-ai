import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./client";

describe("API error formatting", () => {
  it("shows the rejected Pydantic field path", () => {
    expect(getErrorMessage({
      detail: [{ loc: ["body", "element_overrides"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }]
    }, "Request failed")).toBe("element_overrides: Extra inputs are not permitted");
  });

  it("reads structured provider errors", () => {
    expect(getErrorMessage({
      error: { code: "PROVIDER_UNAVAILABLE", message: "AI service is temporarily unavailable.", request_id: "request-1" }
    }, "Request failed")).toBe("AI service is temporarily unavailable.");
  });
});
