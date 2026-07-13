import { useEffect, useState } from "react";
import { Fish, FishOff } from "lucide-react";
import clsx from "clsx";
import { fishAnimationChangeEvent, readFishAnimationEnabled, setFishAnimationEnabled } from "../../motion/fishSettings";

export function FishAnimationToggleButton({ className }: { className?: string }) {
  const [enabled, setEnabled] = useState(() => readFishAnimationEnabled());

  useEffect(() => {
    const update = () => setEnabled(readFishAnimationEnabled());
    window.addEventListener(fishAnimationChangeEvent, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(fishAnimationChangeEvent, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setFishAnimationEnabled(next);
  }

  return (
    <button
      className={clsx("icon-button-dark fish-toggle-button", enabled && "fish-toggle-active", className)}
      onClick={toggle}
      title={enabled ? "Turn fish animation off" : "Turn fish animation on"}
      aria-label={enabled ? "Turn fish animation off" : "Turn fish animation on"}
      aria-pressed={enabled}
      type="button"
    >
      {enabled ? <Fish size={18} /> : <FishOff size={18} />}
    </button>
  );
}
