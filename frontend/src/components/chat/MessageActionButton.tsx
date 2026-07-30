import type { LucideIcon } from "lucide-react";
import { forwardRef } from "react";

export const MessageActionButton = forwardRef<HTMLButtonElement, {
  label: string;
  icon: LucideIcon;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  tone?: "positive" | "negative";
  pressed?: boolean;
  onClick: () => void;
}>(function MessageActionButton({
  label,
  icon: Icon,
  active = false,
  disabled = false,
  loading = false,
  tone,
  pressed,
  onClick
}, ref) {
  return (
    <button
      className={`message-action${active ? " is-active" : ""}${tone ? ` is-${tone}` : ""}`}
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      data-tooltip={label}
      ref={ref}
    >
      <Icon className={loading ? "animate-spin" : ""} size={15} aria-hidden="true" />
    </button>
  );
});
