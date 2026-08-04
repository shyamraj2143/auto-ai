import type { RefObject } from "react";

export function setupKineticReveal(_root: HTMLElement, _options: { disabled?: boolean } = {}) {
  return () => {};
}

/** Scroll reveal was removed. Content renders immediately for every user. */
export function useKineticReveal(_rootRef: RefObject<HTMLElement | null>, _options: { disabled?: boolean } = {}) {}
