import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./TrustHubPage.tsx", import.meta.url), "utf8");
const controls = readFileSync(new URL("./TrustControls.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./trustHub.css", import.meta.url), "utf8");

describe("Trust Hub mobile structure", () => {
  it("keeps online state reactive and reveals the selected navigation item", () => {
    expect(page).toContain("useOnlineStatus()");
    expect(page).not.toContain("navigator.onLine");
    expect(page).toContain("scrollIntoView");
    expect(page).toContain("tabRefs.current[item]");
  });

  it("uses a readable light service surface with mobile-safe controls", () => {
    expect(page).toContain('className="trust-hub-back"');
    expect(styles).toContain(".trust-hub-back { display: grid; width: 44px; height: 44px");
    expect(styles).toContain("background: linear-gradient(135deg,#7c3aed,#5b5bd6)");
    expect(styles).toContain(".trust-hub>footer { display: flex;");
  });

  it("stacks every feature header and action at narrow widths", () => {
    expect(controls).toContain("Request lease");
    expect(styles).toContain(".policy-firewall>header,.trust-controls header,.commitment-escrow>header,.life-map>header { align-items: stretch; flex-direction: column; }");
    expect(styles).toContain(".trust-controls header>button");
  });
});
