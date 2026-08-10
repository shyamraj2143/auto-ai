import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./actionHub.css", import.meta.url), "utf8");
const sevaCss = readFileSync(new URL("./sevaHub.css", import.meta.url), "utf8");
const page = readFileSync(new URL("./ActionHubPage.tsx", import.meta.url), "utf8");

describe("Action Hub responsive contract", () => {
  it("lets the primary grid own every feature position", () => {
    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain("justify-self: stretch");
    expect(sevaCss).not.toMatch(/grid-(?:column|row)/);
  });

  it("keeps phone actions reachable and safe-area aware", () => {
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(css).toContain("var(--safe-top, 0px)");
    expect(css).toContain("var(--safe-bottom, 0px)");
    expect(css).toMatch(/\.hub-welcome-quick\s*\{/);
    expect(page).toContain("hub-welcome-quick");
  });

  it("styles workspace health by its real state", () => {
    expect(page).toContain("useOnlineStatus");
    expect(page).toContain("hub-status-${workspaceStatusTone(status)}");
    expect(css).toContain(".hub-status-error");
    expect(css).toContain(".hub-status-pending");
  });
});
