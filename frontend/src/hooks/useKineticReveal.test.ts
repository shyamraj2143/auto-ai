// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { setupKineticReveal } from "./useKineticReveal";

describe("static reveal compatibility", () => {
  it("leaves content visible and provides cleanup", () => {
    const root = document.createElement("section");
    root.innerHTML = '<p data-kinetic-reveal="left-flight">Visible</p>';
    const cleanup = setupKineticReveal(root);
    expect(root.textContent).toBe("Visible");
    expect(cleanup).toBeTypeOf("function");
    cleanup();
  });
});
