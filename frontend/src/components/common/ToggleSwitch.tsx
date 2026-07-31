import clsx from "clsx";

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  loading = false,
  showStatus = false,
  label
}: {
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<void>;
  disabled?: boolean;
  loading?: boolean;
  showStatus?: boolean;
  label?: string;
}) {
  const unavailable = disabled || loading;
  return (
    <span className="toggle-switch-wrap">
      <button
        type="button"
        className={clsx("settings-toggle toggle-switch", checked && "toggle-switch-on")}
        onClick={() => {
          if (!unavailable) void onChange(!checked);
        }}
        disabled={unavailable}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-busy={loading}
      >
        <span className="toggle-switch-thumb" />
      </button>
      {showStatus && <small className="toggle-switch-status">{loading ? "Saving…" : checked ? "Enabled" : "Disabled"}</small>}
    </span>
  );
}
