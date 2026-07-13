import { useMemo, type CSSProperties } from "react";
import { useMotionMode } from "./MotionProvider";

export function AmbientAurora() {
  const { enabled, canUseAmbient, tier, mode } = useMotionMode();
  const particleCount = enabled && canUseAmbient ? (tier === "high" && mode === "full" ? 56 : 20) : 0;
  const particles = useMemo(() => Array.from({ length: particleCount }, (_, index) => index), [particleCount]);

  if (!enabled) return null;

  return (
    <div className="auto-ai-ambient-aurora" aria-hidden="true">
      <div className="aurora-gradient" />
      <div className="aurora-neural-lines" />
      <div className="aurora-grain" />
      {particles.map((particle) => (
        <span key={particle} style={{ "--particle": particle, "--particles": particleCount } as CSSProperties} />
      ))}
    </div>
  );
}
