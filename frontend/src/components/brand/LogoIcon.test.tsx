// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutoAiLogo } from "./LogoIcon";

afterEach(cleanup);

describe("AutoAiLogo", () => {
  it("uses the Vite-bundled logo instead of a root-relative public path", () => {
    render(<AutoAiLogo loading="eager" />);
    const logo = screen.getByRole("img", { name: "AutoAI" });
    expect(logo.getAttribute("src")).not.toBe("/logo.svg");
    expect(logo.getAttribute("alt")).toBe("AutoAI");
  });

  it("progresses from primary asset to fallback asset to the accessible A mark", () => {
    render(<AutoAiLogo />);
    const primary = screen.getByRole("img", { name: "AutoAI" });
    const primarySrc = primary.getAttribute("src");
    fireEvent.error(primary);

    const fallback = screen.getByRole("img", { name: "AutoAI" });
    expect(fallback.getAttribute("src")).not.toBe(primarySrc);
    fireEvent.error(fallback);

    expect(screen.getByRole("img", { name: "AutoAI" }).textContent).toBe("A");
  });
});
