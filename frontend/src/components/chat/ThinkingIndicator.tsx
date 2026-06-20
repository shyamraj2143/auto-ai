import { AnimatePresence, motion } from "framer-motion";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";

const THINKING_STATES = [
  "Analyzing the thread",
  "Connecting useful memories",
  "Understanding the context",
  "Checking uploaded knowledge",
  "Thinking through the answer",
  "Choosing the cleanest next step"
];

export function ThinkingIndicator() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * THINKING_STATES.length));
  const particles = useMemo(() => Array.from({ length: 14 }, (_, particleIndex) => particleIndex), []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1 + Math.floor(Math.random() * 2)) % THINKING_STATES.length);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

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
        <div className="thinking-core" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="min-w-0">
          <AnimatePresence mode="wait">
            <motion.p
              key={THINKING_STATES[index]}
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.28 }}
              className="truncate text-sm font-medium text-slate-100"
            >
              {THINKING_STATES[index]}
              <span className="morphing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </motion.p>
          </AnimatePresence>
          <p className="mt-1 text-xs text-slate-300/80">Crafting a response with the current context.</p>
        </div>
      </div>
    </div>
  );
}
