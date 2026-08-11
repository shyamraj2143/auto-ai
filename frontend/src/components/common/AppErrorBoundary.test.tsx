// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

function BrokenWorkspace() {
  throw new Error("render failed");
  return null;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("AppErrorBoundary", () => {
  it("opens a safe workspace recovery instead of the generic error screen on the Hub route", () => {
    window.history.replaceState(null, "", "/hub");

    render(
      <AppErrorBoundary>
        <BrokenWorkspace />
      </AppErrorBoundary>
    );

    expect(screen.getByRole("heading", { name: "Action Hub" })).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.getByRole("button", { name: "AI Chat" })).toBeTruthy();
  });
});
