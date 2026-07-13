import { AnimatePresence, motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { NeuralCore } from "../../motion/NeuralCore";

export function ThinkingIndicator({ label, subtitle }: { label?: string; subtitle?: string } = {}) {
  const particles = useMemo(() => Array.from({ length: 14 }, (_, particleIndex) => particleIndex), []);
  const displayLabel = label || "Thinking";

  return (
    <div className="thinking-panel">
      <div className="thinking-particles" aria-hidden="true">
        {particles.map((particle) => (
          <span key={particle} style={{ "--i": particle } as CSSProperties} />
        ))}
      </div>
      <div className="neural-field" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="relative z-10 flex min-w-0 items-center gap-3">
        <NeuralCore className="thinking-core neural-core-chat" state="thinking" size="sm" />
        <div className="min-w-0">
          <AnimatePresence mode="wait">
            <motion.p
              key={displayLabel}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.28 }}
              className="truncate text-sm font-medium text-slate-100"
            >
              {displayLabel}
              <span className="morphing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </motion.p>
          </AnimatePresence>
          <p className="mt-1 text-xs text-slate-300/80">{subtitle || "Crafting a response with the current context."}</p>
        </div>
      </div>
    </div>
  );
}
