import clsx from "clsx";
import { useMemo, type CSSProperties } from "react";
import { type NeuralCoreState } from "./tokens";
import { useMotionMode } from "./MotionProvider";

export function NeuralCore({
  state = "idle",
  size = "md",
  amplitude = 0,
  className,
  label = "Auto-AI Neural Core"
}: {
  state?: NeuralCoreState;
  size?: "sm" | "md" | "lg";
  amplitude?: number;
  className?: string;
  label?: string;
}) {
  const { enabled, reduceMotion, tier, visible } = useMotionMode();
  const nodes = useMemo(() => Array.from({ length: size === "sm" ? 6 : 10 }, (_, index) => index), [size]);
  const safeAmplitude = Math.max(0, Math.min(1, amplitude));
  const dormant = !enabled || reduceMotion || !visible || tier === "low";

  return (
    <div
      className={clsx("auto-neural-core", `auto-neural-core-${size}`, dormant && "is-dormant", className)}
      data-state={state}
      role="img"
      aria-label={label}
      style={{ "--core-amplitude": safeAmplitude } as CSSProperties}
    >
      <span className="core-shell" aria-hidden="true" />
      <span className="core-band band-a" aria-hidden="true" />
      <span className="core-band band-b" aria-hidden="true" />
      <span className="core-halo" aria-hidden="true" />
      <span className="core-flow flow-a" aria-hidden="true" />
      <span className="core-flow flow-b" aria-hidden="true" />
      <span className="core-ring ring-a" aria-hidden="true" />
      <span className="core-ring ring-b" aria-hidden="true" />
      {nodes.map((node) => (
        <span key={node} className="core-node" style={{ "--node": node, "--nodes": nodes.length } as CSSProperties} aria-hidden="true" />
      ))}
    </div>
  );
}
