import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { App } from "@capacitor/app";
import { Check, ChevronDown, X, type LucideIcon } from "lucide-react";

export type AppSelectOption = {
  value: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
};

export type AppSelectProps = {
  value: string | number;
  options: AppSelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  placeholder?: string;
};

export function AppSelect({ value, options, onChange, label, disabled, placeholder = "Select" }: AppSelectProps) {
  const id = useId().replace(/:/g, "");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === String(value)));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.value === String(value));
  const enabledIndexes = useMemo(
    () => options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0),
    [options]
  );

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };

  const move = (direction: 1 | -1) => {
    if (!enabledIndexes.length) return;
    const position = enabledIndexes.indexOf(activeIndex);
    const next = position < 0 ? 0 : (position + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[next]);
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex);
    requestAnimationFrame(() => menuRef.current?.focus());

    const previousOverflow = document.body.style.overflow;
    const previousOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    let removeBack: (() => Promise<void>) | undefined;
    void App.addListener("backButton", () => close()).then((handle) => {
      removeBack = () => handle.remove();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.overscrollBehavior = previousOverscroll;
      void removeBack?.();
    };
  }, [open, selectedIndex]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home" && enabledIndexes.length) {
      event.preventDefault();
      setActiveIndex(enabledIndexes[0]);
    } else if (event.key === "End" && enabledIndexes.length) {
      event.preventDefault();
      setActiveIndex(enabledIndexes[enabledIndexes.length - 1]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
    }
  };

  const overlay = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className="app-select-portal"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) close(false);
          }}
        >
          <div className="app-select-backdrop" aria-hidden="true" />
          <div
            ref={menuRef}
            className="app-select-menu"
            role="listbox"
            id={`${id}-listbox`}
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="app-select-header">
              <strong>{label}</strong>
              <button type="button" onClick={() => close()} aria-label={`Close ${label}`}>
                <X size={18} />
              </button>
            </div>
            <div className="app-select-options">
              {options.map((option, index) => {
                const Icon = option.icon;
                const isSelected = option.value === String(value);
                return (
                  <button
                    type="button"
                    role="option"
                    id={`${id}-option-${index}`}
                    aria-selected={isSelected}
                    key={option.value}
                    disabled={option.disabled}
                    className={`app-select-option${isSelected ? " is-selected" : ""}${activeIndex === index ? " is-active" : ""}`}
                    onPointerMove={() => !option.disabled && setActiveIndex(index)}
                    onClick={() => choose(index)}
                  >
                    {Icon && <Icon className="app-select-option-icon" size={19} aria-hidden="true" />}
                    <span className="app-select-option-copy">
                      <span>{option.label}</span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    <span className="app-select-check" aria-hidden="true">{isSelected && <Check size={16} />}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="app-select-root">
      <button
        ref={triggerRef}
        type="button"
        className="app-select"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onKeyDown}
      >
        <span className="app-select-value">{selected?.label ?? placeholder}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {overlay}
    </div>
  );
}
