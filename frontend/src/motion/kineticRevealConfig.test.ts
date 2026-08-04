import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("motion removal", () => {
  it("renders public pages without scroll reveal hooks", () => {
    const landing = readFileSync(new URL("../components/landing/LandingPage.tsx", import.meta.url), "utf8");
    const cms = readFileSync(new URL("../components/common/PublicCmsPage.tsx", import.meta.url), "utf8");
    expect(`${landing}\n${cms}`).not.toMatch(/useKineticReveal|kineticReveal\.css/);
  });

  it("enforces static presentation globally", () => {
    const css = readFileSync(new URL("../styles/performance.css", import.meta.url), "utf8");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition: none !important");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});
