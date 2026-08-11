// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { User } from "../../types";
import { HubHeader } from "./HubHeader";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseUser: User = {
  id: "user-1",
  email: "user@example.com",
  name: "AutoAI User",
  provider: "password",
  is_admin: false,
  role: "user",
  subscription_status: "free",
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};

describe("HubHeader", () => {
  it("does not crash when a restored mobile session has no display name", () => {
    const user = { ...baseUser, name: undefined } as unknown as User;

    render(
      <MemoryRouter>
        <HubHeader user={user} unreadNotifications={0} onOpenQuickConnect={vi.fn()} onLogout={vi.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByText("AutoAI User")).toBeTruthy();
    expect(screen.getByLabelText("Open profile")).toBeTruthy();
  });
});
