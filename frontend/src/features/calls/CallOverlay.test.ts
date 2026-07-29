import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./CallOverlay.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./calls.css", import.meta.url), "utf8");

describe("website call surface parity", () => {
  it("replaces normal incoming acceptance choices with Retry after setup failure", () => {
    expect(source).toContain('failure ? "Retry" : "Accept"');
    expect(source).toContain("!failure && call?.call_type === \"video\"");
    expect(source).toContain('aria-label={failure ? "Retry accepting call" : "Accept call"}');
  });

  it("shows only friendly production errors and keeps diagnostics development-only", () => {
    expect(source).toContain("callFailurePresentation(error, import.meta.env.DEV)");
    expect(source).not.toContain("<span>{error}</span>");
    expect(source).toContain("Copy diagnostics");
  });

  it("guards call controls against duplicate taps and uses the native cyan-blue accept treatment", () => {
    expect(source).toContain("window.setTimeout(() => setControlPending(false), 350)");
    expect(source).toContain("disabled={controlPending}");
    expect(styles).toContain(".incoming-call-actions .accept{background:linear-gradient(145deg,#22d3ee,#2563eb)}");
  });
});
