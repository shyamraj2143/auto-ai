import { describe, expect, it } from "vitest";
import { getErrorMessage, normalizeApiUrl } from "./client";

describe("API URL normalization", () => {
  it("converts a hostname-only production URL to HTTPS", () => {
    expect(normalizeApiUrl("auto-ai-production-a6ef.up.railway.app/api/v1"))
      .toBe("https://auto-ai-production-a6ef.up.railway.app/api/v1");
  });

  it("preserves an absolute HTTPS API URL", () => {
    expect(normalizeApiUrl("https://auto-ai-production-a6ef.up.railway.app/api/v1"))
      .toBe("https://auto-ai-production-a6ef.up.railway.app/api/v1");
  });
});

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
