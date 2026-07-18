import { describe, expect, it } from "vitest";
import { oceanDebugStateLabel } from "./oceanDebug";

describe("ocean debug diagnostics", () => {
  it("labels the stable homepage phase for runtime inspection", () => {
    expect(oceanDebugStateLabel("idle")).toBe("home-calm");
    expect(oceanDebugStateLabel("expanding")).toBe("expanding");
  });
});
