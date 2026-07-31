// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutoAiLogo } from "./LogoIcon";

afterEach(cleanup);

describe("AutoAiLogo", () => {
  it("renders the official logo inline without a fallible image request", () => {
    render(<AutoAiLogo loading="eager" />);
    const logo = screen.getByRole("img", { name: "AutoAI" });

    expect(logo.tagName.toLowerCase()).toBe("svg");
    expect(logo.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(logo.getAttribute("data-autoai-logo")).toBe("inline-v3");
    expect(logo.getAttribute("src")).toBeNull();
    expect(logo.getAttribute("width")).toBe("36");
    expect(logo.getAttribute("height")).toBe("36");
    expect(logo.classList.contains("autoai-logo")).toBe(true);
    expect(logo.getAttribute("style")).toBeNull();
  });

  it("supports an explicit size without allowing a percentage-based expansion", () => {
    render(<AutoAiLogo size={48} />);
    const logo = screen.getByRole("img", { name: "AutoAI" });

    expect(logo.getAttribute("width")).toBe("48");
    expect(logo.getAttribute("height")).toBe("48");
    expect(logo.getAttribute("style")).toContain("width: 48px");
    expect(logo.getAttribute("style")).not.toContain("100%");
  });

  it("supports decorative usage without adding an accessible duplicate name", () => {
    const { container } = render(<AutoAiLogo alt="" />);
    const logo = container.querySelector("svg[data-autoai-logo='inline-v3']");

    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
