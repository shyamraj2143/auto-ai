import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("landing performance", () => {
  it("does not load GSAP cinematic motion", () => {
    const landing = readFileSync(new URL("../components/landing/LandingPage.tsx", import.meta.url), "utf8");
    expect(landing).not.toMatch(/useLuxuryCinematic|luxuryCinematic\.css|\bgsap\b/);
  });
});
