import { useEffect, useRef } from "react";
import { useMotionMode } from "./MotionProvider";

export function CognitiveThread() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const branchRef = useRef<SVGPathElement | null>(null);
  const { canUseCinematic, reduceMotion } = useMotionMode();

  useEffect(() => {
    if (!canUseCinematic || reduceMotion || !rootRef.current || !pathRef.current || !branchRef.current) return;
    if (window.matchMedia("(max-width: 768px)").matches) return;

    let cleanup = () => {};
    let active = true;

    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([gsapModule, scrollTriggerModule]) => {
      if (!active || !rootRef.current || !pathRef.current || !branchRef.current) return;
      const gsap = gsapModule.gsap;
      const ScrollTrigger = scrollTriggerModule.ScrollTrigger;
      gsap.registerPlugin(ScrollTrigger);

      const context = gsap.context(() => {
        const paths = [pathRef.current, branchRef.current].filter(Boolean) as SVGPathElement[];
        paths.forEach((path) => {
          const length = path.getTotalLength();
          gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
        });

        gsap.to(pathRef.current, {
          strokeDashoffset: 0,
          ease: "none",
          scrollTrigger: {
            trigger: rootRef.current,
            start: "top top",
            end: "bottom bottom",
            scrub: 0.8
          }
        });

        gsap.to(branchRef.current, {
          strokeDashoffset: 0,
          opacity: 0.9,
          ease: "none",
          scrollTrigger: {
            trigger: rootRef.current,
            start: "18% top",
            end: "72% bottom",
            scrub: 0.9
          }
        });

        gsap.to(".cognitive-thread-pulse", {
          opacity: 0.82,
          scale: 1.18,
          transformOrigin: "center",
          yoyo: true,
          repeat: -1,
          duration: 1.8,
          ease: "sine.inOut"
        });
      }, rootRef);

      cleanup = () => context.revert();
    });

    return () => {
      active = false;
      cleanup();
    };
  }, [canUseCinematic, reduceMotion]);

  if (!canUseCinematic || reduceMotion) return null;

  return (
    <div ref={rootRef} className="cognitive-thread" aria-hidden="true">
      <svg viewBox="0 0 1000 4300" preserveAspectRatio="none" focusable="false">
        <defs>
          <linearGradient id="cognitive-thread-gradient" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.16" />
            <stop offset="26%" stopColor="#a78bfa" stopOpacity="0.7" />
            <stop offset="54%" stopColor="#86efac" stopOpacity="0.62" />
            <stop offset="78%" stopColor="#fcd34d" stopOpacity="0.54" />
            <stop offset="100%" stopColor="#67e8f9" stopOpacity="0.22" />
          </linearGradient>
          <filter id="cognitive-thread-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          className="cognitive-thread-ghost"
          d="M132 165 C278 210 368 212 472 292 C604 394 604 586 486 704 C346 844 496 1040 668 1068 C820 1092 872 1218 754 1330 C548 1524 240 1516 274 1748 C300 1924 646 1878 724 2094 C814 2348 298 2292 366 2574 C426 2822 854 2710 794 3022 C746 3270 248 3176 280 3482 C304 3708 650 3694 744 3892 C810 4032 654 4112 498 4174"
        />
        <path
          ref={pathRef}
          className="cognitive-thread-path"
          d="M132 165 C278 210 368 212 472 292 C604 394 604 586 486 704 C346 844 496 1040 668 1068 C820 1092 872 1218 754 1330 C548 1524 240 1516 274 1748 C300 1924 646 1878 724 2094 C814 2348 298 2292 366 2574 C426 2822 854 2710 794 3022 C746 3270 248 3176 280 3482 C304 3708 650 3694 744 3892 C810 4032 654 4112 498 4174"
        />
        <path
          ref={branchRef}
          className="cognitive-thread-branch"
          d="M458 870 C536 812 626 812 706 876 M528 1160 C454 1244 360 1240 286 1162 M642 1880 C734 1802 812 1828 884 1914 M378 2480 C288 2564 190 2538 132 2430 M704 3348 C792 3438 846 3544 786 3656"
        />
        <circle className="cognitive-thread-pulse" cx="132" cy="165" r="4.5" />
      </svg>
    </div>
  );
}
