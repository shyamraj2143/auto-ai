import clsx from "clsx";
import {
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from "react";
import { X } from "lucide-react";
import type { PrismStatusTone } from "../../prism/tokens";

export function PrismSurface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("prism-surface", className)} {...props} />;
}

export function PrismCard({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <article className={clsx("prism-card", className)} {...props} />;
}

export function PrismButton({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={clsx("prism-button", className)} {...props}>{children}</button>;
}

export function PrismBadge({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={clsx("prism-badge", className)} {...props}>{children}</span>;
}

export function PrismIconButton({ className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={clsx("prism-icon-button", className)} {...props}>{children}</button>;
}

export function PrismTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="prism-tooltip">
      {children}
      <span className="prism-tooltip-content" role="tooltip">{label}</span>
    </span>
  );
}

export function PrismDialog({
  open,
  title,
  description,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="prism-dialog-layer" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section
        className="prism-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="prism-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <PrismIconButton autoFocus type="button" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </PrismIconButton>
        </header>
        <div className="prism-dialog-body">{children}</div>
      </section>
    </div>
  );
}

export function PrismNavigation({ className, ...props }: React.ComponentPropsWithoutRef<"nav">) {
  return <nav className={clsx("prism-navigation", className)} {...props} />;
}

export function PrismInput({ label, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const inputId = useId();
  return (
    <label className="prism-input-label" htmlFor={inputId}>
      <span>{label}</span>
      <input id={inputId} className={clsx("prism-input", className)} {...props} />
    </label>
  );
}

export function PrismTabs<T extends string>({
  label,
  items,
  active,
  onChange,
  className
}: {
  label: string;
  items: ReadonlyArray<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx("prism-tabs", className)} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function PrismStatusChip({
  tone = "idle",
  icon,
  children,
  className
}: {
  tone?: PrismStatusTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return <span className={clsx("prism-status-chip", `is-${tone}`, className)}>{icon}{children}</span>;
}

export function PrismEmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="prism-empty-state" role="status">
      <span aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

export function PrismReveal({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-kinetic-reveal="depth-landing"
      data-kinetic-group
      className={clsx("prism-reveal", className)}
      {...props}
    />
  );
}
