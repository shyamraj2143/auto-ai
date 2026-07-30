import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

type MenuPosition = { top: number; right: number };

export function DismissibleMenu({
  open,
  menuId,
  menuRef,
  triggerRef,
  onClose,
  children
}: {
  open: boolean;
  menuId: string;
  menuRef: React.MutableRefObject<HTMLDivElement | null>;
  triggerRef: React.MutableRefObject<HTMLButtonElement | null>;
  onClose: (restoreFocus?: boolean) => void;
  children: React.ReactNode;
}) {
  const [position, setPosition] = useState<MenuPosition>({ top: 56, right: 12 });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      setPosition({
        top: Math.min(window.innerHeight - 16, rect.bottom + 6),
        right: Math.max(8, window.innerWidth - rect.right)
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
    }, 0);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(true);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? []
      );
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      items[(current + offset + items.length) % items.length].focus();
    };
    const onPopState = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("popstate", onPopState);
    let disposed = false;
    let nativeListener: { remove: () => Promise<void> } | undefined;
    if (Capacitor.isNativePlatform()) {
      void App.addListener("backButton", () => onClose(true)).then((listener) => {
        if (disposed) {
          void listener.remove();
        } else {
          nativeListener = listener;
        }
      });
    }
    return () => {
      disposed = true;
      window.clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("popstate", onPopState);
      void nativeListener?.remove();
    };
  }, [menuRef, onClose, open, triggerRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      className="chat-actions-menu"
      role="menu"
      style={{ top: position.top, right: position.right }}
    >
      {children}
    </div>,
    document.body
  );
}
