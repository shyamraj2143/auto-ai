// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useOnlineStatus } from "./useOnlineStatus";

const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");

afterEach(() => {
  if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
  else delete (navigator as unknown as { onLine?: boolean }).onLine;
});

describe("useOnlineStatus", () => {
  it("reacts to browser online and offline events", () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    const { result, unmount } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);

    act(() => window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);

    act(() => window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);
    unmount();
  });
});
