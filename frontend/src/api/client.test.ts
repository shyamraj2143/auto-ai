import { describe, expect, it } from "vitest";
import {
  getErrorMessage,
  normalizeApiUrl,
  resolveLocalPreviewApiBaseUrl,
  resolveUnconfiguredApiBaseUrl
} from "./client";

describe("API URL normalization", () => {
  it("converts a hostname-only production URL to HTTPS", () => {
    expect(normalizeApiUrl("auto-ai-production-a6ef.up.railway.app/api/v1"))
      .toBe("https://auto-ai-production-a6ef.up.railway.app/api/v1");
  });

  it("preserves an absolute HTTPS API URL", () => {
    expect(normalizeApiUrl("https://auto-ai-production-a6ef.up.railway.app/api/v1"))
      .toBe("https://auto-ai-production-a6ef.up.railway.app/api/v1");
  });

  it("uses the local backend for an unconfigured localhost preview build", () => {
    expect(resolveUnconfiguredApiBaseUrl({ hostname: "localhost", protocol: "http:" }, false))
      .toBe("http://localhost:8000/api/v1");
    expect(resolveUnconfiguredApiBaseUrl({ hostname: "127.0.0.1", protocol: "http:" }, false))
      .toBe("http://127.0.0.1:8000/api/v1");
  });

  it("keeps a localhost production preview local even when the build has a public API URL", () => {
    expect(resolveLocalPreviewApiBaseUrl({ hostname: "localhost", protocol: "http:" }, false, false))
      .toBe("http://localhost:8000/api/v1");
    expect(resolveLocalPreviewApiBaseUrl({ hostname: "localhost", protocol: "http:" }, false, true))
      .toBe("");
  });

  it("keeps Capacitor and non-local production pages on the public API", () => {
    expect(resolveUnconfiguredApiBaseUrl({ hostname: "localhost", protocol: "https:" }, true))
      .toBe("https://auto-ai-production-a6ef.up.railway.app/api/v1");
    expect(resolveUnconfiguredApiBaseUrl({ hostname: "autoai.example", protocol: "https:" }, false))
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
