import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { constrainFloatingPosition, floatingAnchorPosition, nearestFloatingAnchor, type FloatingAnchor } from "./floatingPosition";

export function useFloatingPanel({
  storageKey,
  defaultAnchor = "bottom-center",
  allowCenter = true,
  bottomInset = 12,
}: {
  storageKey: string;
  defaultAnchor?: FloatingAnchor;
  allowCenter?: boolean;
  bottomInset?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const [position, setPosition] = useState({ x: 12, y: 12 });

  const bounds = useCallback(() => ({ width: window.visualViewport?.width ?? window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight, insetBottom: bottomInset }), [bottomInset]);

  const snap = useCallback((candidate = position) => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const panel = { width: rect.width, height: rect.height };
    const anchor = nearestFloatingAnchor(candidate, panel, bounds(), allowCenter);
    localStorage.setItem(storageKey, anchor);
    setPosition(floatingAnchorPosition(anchor, panel, bounds()));
  }, [allowCenter, bounds, position, storageKey]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const reposition = () => {
      const rect = node.getBoundingClientRect();
      const saved = localStorage.getItem(storageKey) as FloatingAnchor | null;
      const anchor = saved ?? defaultAnchor;
      setPosition(floatingAnchorPosition(anchor, { width: rect.width, height: rect.height }, bounds()));
    };
    const observer = new ResizeObserver(reposition);
    observer.observe(node);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    reposition();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
    };
  }, [bounds, defaultAnchor, storageKey]);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button,input,select,a,[data-no-drag]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition(constrainFloatingPosition({ x: drag.current.originX + event.clientX - drag.current.x, y: drag.current.originY + event.clientY - drag.current.y }, { width: rect.width, height: rect.height }, bounds()));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    snap();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !ref.current) return;
    event.preventDefault();
    const delta = event.shiftKey ? 24 : 8;
    const next = { x: position.x + (event.key === "ArrowLeft" ? -delta : event.key === "ArrowRight" ? delta : 0), y: position.y + (event.key === "ArrowUp" ? -delta : event.key === "ArrowDown" ? delta : 0) };
    const rect = ref.current.getBoundingClientRect();
    setPosition(constrainFloatingPosition(next, { width: rect.width, height: rect.height }, bounds()));
  }

  return {
    ref: ref as RefObject<HTMLDivElement>,
    style: { left: position.x, top: position.y } as CSSProperties,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown,
    snap,
  };
}
