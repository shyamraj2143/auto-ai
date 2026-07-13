import { AnimatePresence, motion, useInView, type HTMLMotionProps, type Variants } from "framer-motion";
import { useRef, type ReactNode } from "react";
import { motionDurations, motionEase } from "./tokens";
import { useMotionMode } from "./MotionProvider";

export { AnimatePresence };

const pageVariants: Variants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 }
};

export function AnimatedPage({ children, className }: { children: ReactNode; className?: string }) {
  const { reduceMotion, enabled } = useMotionMode();
  if (!enabled || reduceMotion) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: motionDurations.page, ease: motionEase.standard }}
    >
      {children}
    </motion.div>
  );
}

export function Reveal({
  children,
  className,
  delay = 0,
  y = 12,
  x = 0,
  scale = 1,
  rotate = 0,
  blur = 0,
  once = true
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  x?: number;
  scale?: number;
  rotate?: number;
  blur?: number;
  once?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once, margin: "-10% 0px -10% 0px" });
  const { enabled, reduceMotion } = useMotionMode();
  if (!enabled || reduceMotion) return <div ref={ref} className={className}>{children}</div>;
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, x, y, scale, rotate, filter: blur ? `blur(${blur}px)` : "none" }}
      animate={inView ? { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0, filter: "blur(0px)" } : { opacity: 0, x, y, scale, rotate, filter: blur ? `blur(${blur}px)` : "none" }}
      transition={{ duration: motionDurations.hero, delay, ease: motionEase.enter }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerGroup({ children, className }: { children: ReactNode; className?: string }) {
  const { enabled, reduceMotion } = useMotionMode();
  if (!enabled || reduceMotion) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial="initial"
      whileInView="animate"
      viewport={{ once: true, margin: "-10% 0px -10% 0px" }}
      variants={{
        initial: {},
        animate: { transition: { staggerChildren: 0.075 } }
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const { enabled, reduceMotion } = useMotionMode();
  if (!enabled || reduceMotion) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={{
        initial: { opacity: 0, y: 10 },
        animate: { opacity: 1, y: 0 }
      }}
      transition={{ duration: motionDurations.card, ease: motionEase.enter }}
    >
      {children}
    </motion.div>
  );
}

export function FlyText({ text, className }: { text: string; className?: string }) {
  const { enabled, reduceMotion } = useMotionMode();
  if (!enabled || reduceMotion) return <span className={className}>{text}</span>;
  return (
    <motion.span
      className={className}
      initial="initial"
      whileInView="animate"
      viewport={{ once: true, margin: "-12% 0px -12% 0px" }}
      variants={{
        initial: {},
        animate: { transition: { staggerChildren: 0.045 } }
      }}
      aria-label={text}
    >
      {text.split(" ").map((word, index) => (
        <motion.span
          aria-hidden="true"
          className="fly-word"
          key={`${word}-${index}`}
          variants={{
            initial: { opacity: 0, y: 18, rotateX: 38, filter: "blur(8px)" },
            animate: { opacity: 1, y: 0, rotateX: 0, filter: "blur(0px)" }
          }}
          transition={{ duration: motionDurations.hero, ease: motionEase.enter }}
        >
          {word}
        </motion.span>
      ))}
    </motion.span>
  );
}

export function PressableButton(props: HTMLMotionProps<"button">) {
  const { enabled, reduceMotion } = useMotionMode();
  if (!enabled || reduceMotion) return <motion.button {...props} />;
  return <motion.button whileTap={{ scale: 0.975 }} transition={{ duration: motionDurations.instant }} {...props} />;
}

export function TiltCard({ children, className, ...props }: HTMLMotionProps<"div"> & { children: ReactNode; className?: string }) {
  const { canUsePointerEffects } = useMotionMode();
  if (!canUsePointerEffects) return <motion.div className={className} {...props}>{children}</motion.div>;
  return (
    <motion.div
      className={className}
      whileHover={{ y: -2, rotateX: 0.5, rotateY: -0.5 }}
      transition={{ duration: motionDurations.control, ease: motionEase.standard }}
      {...props}
    >
      {children}
    </motion.div>
  );
}

export function StreamingPulse({ active }: { active: boolean }) {
  return <span className={active ? "streaming-pulse active" : "streaming-pulse"} aria-hidden="true" />;
}
