// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndustrialLoader } from "./IndustrialLoader";

afterEach(cleanup);

describe("IndustrialLoader", () => {
  it("announces a real startup state without fabricated progress", () => {
    render(<IndustrialLoader status="Restoring session" />);
    const loader = screen.getByRole("status");
    expect(loader.textContent).toContain("Restoring session");
    expect(loader.textContent).toContain("Starting AutoAI");
    expect(loader.textContent).toContain("Preparing your workspace");
    expect(loader.getAttribute("data-stage")).toBe("0");
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("maps real startup status to the visible step sequence", () => {
    render(<IndustrialLoader status="Connecting securely" />);
    expect(screen.getByRole("status").getAttribute("data-stage")).toBe("1");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("Connecting securely");
    expect(screen.getByRole("list", { name: "Startup progress" }).textContent).toContain("Loading workspace");
  });

  it("shows an actionable retry after failure", () => {
    const retry = vi.fn();
    render(<IndustrialLoader error="Connection failed" onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
