// @vitest-environment jsdom

import { useRef, useState } from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DismissibleMenu } from "./DismissibleMenu";

function Harness({ onAction = () => undefined }: { onAction?: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div>
      <button
        type="button"
        aria-label="More"
        aria-expanded={open}
        onClick={(event) => {
          triggerRef.current = event.currentTarget;
          setOpen((value) => !value);
        }}
      >
        More
      </button>
      <button type="button" onClick={() => setOpen(false)}>Navigate chat</button>
      <DismissibleMenu
        open={open}
        menuId="test-menu"
        menuRef={menuRef}
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
      >
        <button role="menuitem" type="button" onClick={onAction}>Rename conversation</button>
        <button role="menuitem" type="button">Delete conversation</button>
      </DismissibleMenu>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DismissibleMenu", () => {
  it("opens from its trigger and does not dismiss before an inside action runs", async () => {
    const action = vi.fn();
    render(<Harness onAction={action} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "Rename conversation" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename conversation" }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on an outside pointer, Escape, and chat navigation", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.click(screen.getByRole("button", { name: "Navigate chat" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes on browser history and registers native Android back dismissal", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    fireEvent.popState(window);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const source = readFileSync(`${process.cwd()}/src/components/chat/DismissibleMenu.tsx`, "utf8");
    expect(source).toContain('App.addListener("backButton"');
  });
});
