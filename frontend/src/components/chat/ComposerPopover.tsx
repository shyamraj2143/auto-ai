import { type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ComposerPopoverProps = {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  preferredWidth?: number;
  maxWidth?: number;
  ariaLabel: string;
  placement?: "top-start" | "top-end";
  className?: string;
  backdrop?: "subtle" | "model";
};

type Position = Pick<CSSProperties, "left" | "bottom" | "width" | "maxHeight">;

export function calculateComposerPopoverPosition({
  triggerRect,
  viewportLeft,
  viewportTop,
  viewportWidth,
  viewportHeight,
  windowHeight,
  preferredWidth,
  maxWidth,
  placement
}: {
  triggerRect: Pick<DOMRect, "top" | "left" | "right">;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  windowHeight: number;
  preferredWidth: number;
  maxWidth: number;
  placement: "top-start" | "top-end";
}): Position {
  const viewportRight = viewportLeft + viewportWidth;
  const viewportBottom = viewportTop + viewportHeight;
  const availableWidth = Math.max(0, viewportWidth - 24);
  const width = Math.min(preferredWidth, maxWidth, availableWidth);
  const desiredLeft = placement === "top-end" ? triggerRect.right - width : triggerRect.left;
  const left = Math.max(viewportLeft + 12, Math.min(desiredLeft, viewportRight - width - 12));
  const anchorTop = Math.min(triggerRect.top, viewportBottom - 8);
  const bottom = Math.max(windowHeight - viewportBottom + 8, windowHeight - anchorTop + 8);
  const maxHeight = Math.max(112, Math.min(440, anchorTop - viewportTop - 16));
  return { left, bottom, width, maxHeight };
}

function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'));
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement as HTMLElement);
  let next = current;
  if (event.key === "ArrowDown") next = current < buttons.length - 1 ? current + 1 : 0;
  else if (event.key === "ArrowUp") next = current > 0 ? current - 1 : buttons.length - 1;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else return;
  event.preventDefault();
  buttons[next]?.focus({ preventScroll: true });
}

export function ComposerPopover({
  open,
  triggerRef,
  onClose,
  children,
  preferredWidth = 240,
  maxWidth = 420,
  ariaLabel,
  placement = "top-start",
  className = "",
  backdrop = "subtle"
}: ComposerPopoverProps) {
  const reactId = useId().replace(/:/g, "");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<Position>({ left: 12, bottom: 12, width: preferredWidth, maxHeight: 440 });

  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let portalRoot = document.getElementById("composer-popover-root");
    if (!portalRoot) {
      portalRoot = document.createElement("div");
      portalRoot.id = "composer-popover-root";
      document.body.appendChild(portalRoot);
    }
    setRoot(portalRoot);
    return () => setRoot(null);
  }, [open]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const triggerRect = trigger.getBoundingClientRect();
    setPosition(calculateComposerPopoverPosition({
      triggerRect,
      viewportLeft,
      viewportTop,
      viewportWidth,
      viewportHeight,
      windowHeight: window.innerHeight,
      preferredWidth,
      maxWidth,
      placement
    }));
  }, [maxWidth, placement, preferredWidth, triggerRef]);

  useLayoutEffect(() => {
    if (!open || !root) return;
    reposition();
    const viewport = window.visualViewport;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("orientationchange", reposition);
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("orientationchange", reposition);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    };
  }, [open, reposition, root, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const closeOnKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeRef.current();
    };
    const closeOnBack = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", closeOnKey);
    window.addEventListener("auto-ai-android-back", closeOnBack);
    return () => {
      document.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("auto-ai-android-back", closeOnBack);
      window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
    };
  }, [open, triggerRef]);

  if (!open || !root) return null;

  return createPortal(
    <div className="composer-popover-layer" data-composer-popover={reactId}>
      <button
        type="button"
        className={`composer-popover-backdrop composer-popover-backdrop-${backdrop}`}
        aria-label={`Close ${ariaLabel}`}
        onPointerDown={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={panelRef}
        className={`composer-popover ${className}`.trim()}
        style={position}
        role="dialog"
        aria-label={ariaLabel}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={moveMenuFocus}
      >
        {children}
      </div>
    </div>,
    root
  );
}
