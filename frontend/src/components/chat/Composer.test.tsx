// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../api/client", () => ({ api: { intelligenceConfig: vi.fn().mockResolvedValue({ modes: {}, models: [], refreshed: true }) } }));
vi.mock("../../contexts/AuthContext", () => ({ useAuth: () => ({ token: "token" }) }));
vi.mock("../../contexts/AppSettingsContext", () => ({ useAppSettings: () => ({ settings: { voiceEnabled: false } }) }));
vi.mock("../../crystal/useCrystalEffects", () => ({ useCrystalEffects: () => ({ surfaces: false }) }));
vi.mock("../../hooks/useCmsContent", () => ({ usePublishedUiText: () => ({}) }));

import { Composer } from "./Composer";

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

function renderComposer(onSend = vi.fn().mockResolvedValue(true), focusKey = "chat-1") {
  return {
    onSend,
    ...render(<Composer focusKey={focusKey} selectedDocuments={[]} selectedLibraryAttachments={[]} uploadTasks={[]} onRemoveDocument={() => undefined} onRemoveLibraryAttachment={() => undefined} onDeleteDocument={vi.fn()} onUploadDocuments={vi.fn()} onSend={onSend} onOpenLiveMode={() => undefined} />)
  };
}

describe("simple chat composer", () => {
  it("sends with Enter and preserves a newline with Shift+Enter", async () => {
    const { onSend } = renderComposer();
    const input = screen.getByLabelText("Message AutoAI");
    fireEvent.change(input, { target: { value: "Hello AutoAI" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("does not submit Enter during IME composition", () => {
    const { onSend } = renderComposer();
    const input = screen.getByLabelText("Message AutoAI");
    fireEvent.change(input, { target: { value: "नमस्ते" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("restores an unsent draft for the same conversation", () => {
    const first = renderComposer();
    fireEvent.change(screen.getByLabelText("Message AutoAI"), { target: { value: "saved offline draft" } });
    first.unmount();
    renderComposer(vi.fn(), "chat-1");
    expect((screen.getByLabelText("Message AutoAI") as HTMLTextAreaElement).value).toBe("saved offline draft");
  });
});
