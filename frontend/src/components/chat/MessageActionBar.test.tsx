// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import type { Message } from "../../types";
import { MessageActionBar, nextFeedbackRating } from "./MessageActionBar";
import { shouldShowMessageActions } from "./MessageBubble";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Useful answer",
    created_at: "2026-07-30T00:00:00Z",
    ...overrides
  };
}

function renderBar(value = message(), streaming = false) {
  const onFeedbackChange = vi.fn();
  render(
    <MessageActionBar
      message={value}
      chatId="chat-1"
      token="token"
      content={value.content}
      isStreaming={streaming}
      onFeedbackChange={onFeedbackChange}
      onShare={vi.fn()}
      onRegenerate={vi.fn()}
    />
  );
  return onFeedbackChange;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MessageActionBar", () => {
  it("renders the required assistant action order", () => {
    renderBar();
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Copy message",
      "Like response",
      "Dislike response",
      "Share response",
      "Regenerate response"
    ]);
  });

  it("renders only compact Copy for user messages", () => {
    renderBar(message({ id: "user-1", role: "user" }));
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("saves Like optimistically and persists it", async () => {
    const saved = { message_id: "assistant-1", rating: 1 as const, updated_at: "2026-07-30T00:00:01Z" };
    vi.spyOn(api, "putMessageFeedback").mockResolvedValue(saved);
    const changed = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Like response" }));
    expect(screen.getByRole("button", { name: "Like response" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(api.putMessageFeedback).toHaveBeenCalledWith("token", "chat-1", "assistant-1", {
      rating: 1,
      reason: null,
      comment: null
    }));
    expect(changed).toHaveBeenLastCalledWith("assistant-1", saved);
  });

  it("saves a Dislike reason and replaces Like atomically", async () => {
    vi.spyOn(api, "putMessageFeedback").mockResolvedValue({
      message_id: "assistant-1",
      rating: -1,
      reason: "incorrect",
      updated_at: "2026-07-30T00:00:02Z"
    });
    renderBar(message({
      feedback: { message_id: "assistant-1", rating: 1, updated_at: "2026-07-30T00:00:01Z" }
    }));
    fireEvent.click(screen.getByRole("button", { name: "Dislike response" }));
    fireEvent.click(screen.getByRole("button", { name: "Incorrect" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(api.putMessageFeedback).toHaveBeenCalledWith("token", "chat-1", "assistant-1", {
      rating: -1,
      reason: "incorrect",
      comment: null
    }));
    expect(screen.getByRole("button", { name: "Dislike response" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Like response" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("toggles active feedback off", async () => {
    vi.spyOn(api, "deleteMessageFeedback").mockResolvedValue(undefined);
    renderBar(message({
      feedback: { message_id: "assistant-1", rating: 1, updated_at: "2026-07-30T00:00:01Z" }
    }));
    fireEvent.click(screen.getByRole("button", { name: "Like response" }));
    await waitFor(() => expect(api.deleteMessageFeedback).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Like response" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("rolls back optimistic feedback after an API failure", async () => {
    vi.spyOn(api, "deleteMessageFeedback").mockRejectedValue(new Error("offline"));
    renderBar(message({
      feedback: { message_id: "assistant-1", rating: 1, updated_at: "2026-07-30T00:00:01Z" }
    }));
    fireEvent.click(screen.getByRole("button", { name: "Like response" }));
    await screen.findByText("Feedback was not saved. Try again.");
    expect(screen.getByRole("button", { name: "Like response" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("restores persisted feedback and disables response actions while streaming", () => {
    renderBar(message({
      feedback: { message_id: "assistant-1", rating: -1, reason: "outdated", updated_at: "2026-07-30T00:00:01Z" }
    }), true);
    expect(screen.getByRole("button", { name: "Dislike response" }).getAttribute("aria-pressed")).toBe("true");
    for (const name of ["Like response", "Dislike response", "Share response", "Regenerate response"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("keeps feedback mutually exclusive and hides actions for an empty failure", () => {
    expect(nextFeedbackRating(1, -1)).toBe(-1);
    expect(nextFeedbackRating(-1, -1)).toBeNull();
    expect(shouldShowMessageActions({ isEmptyStreaming: false, isFailedAssistant: true })).toBe(false);
  });

  it("locks message actions to a compact horizontal row", () => {
    const css = readFileSync(`${process.cwd()}/src/styles/index.css`, "utf8");
    expect(css).toMatch(/\.message-actions\s*\{[\s\S]*?flex-direction:\s*row\s*!important/);
    expect(css).toMatch(/\.message-row-user \.message-actions\s*\{[\s\S]*?justify-content:\s*flex-end/);
  });
});
