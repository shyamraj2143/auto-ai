import { useLayoutEffect, type RefObject } from "react";
import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  LUXURY_CINEMATIC_CONFIG,
  LUXURY_SELECTORS,
  shouldDisableLuxuryMotion
} from "../motion/luxuryCinematicConfig";

gsap.registerPlugin(ScrollTrigger, CustomEase);

function revealImmediately(root: HTMLElement) {
  root.classList.remove("luxury-cinematic-loading", "luxury-cinematic-ready");
  root.querySelectorAll<HTMLElement>(LUXURY_SELECTORS.headingLine).forEach((line) => {
    line.style.opacity = "1";
    line.style.transform = "none";
    line.style.filter = "none";
  });
  root.querySelectorAll<HTMLElement>(LUXURY_SELECTORS.headingWord).forEach((word) => {
    word.style.opacity = "1";
    word.style.transform = "none";
    word.style.filter = "none";
  });
  root.querySelectorAll<HTMLElement>(LUXURY_SELECTORS.media).forEach((media) => {
    media.style.clipPath = LUXURY_CINEMATIC_CONFIG.revealedClipPath;
  });
  root.querySelectorAll<HTMLElement>(LUXURY_SELECTORS.parallax).forEach((element) => {
    element.style.transform = "none";
  });
  const loader = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loader);
  if (loader) {
    loader.style.display = "none";
    loader.style.pointerEvents = "none";
  }
}

function getScrollContainer(root: HTMLElement) {
  const appRoot = document.getElementById("root");
  return appRoot?.contains(root) && appRoot.scrollHeight > appRoot.clientHeight ? appRoot : undefined;
}

export function useLuxuryCinematic(
  rootRef: RefObject<HTMLElement>,
  { disabled = false }: { disabled?: boolean } = {}
) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const localMotionPreview = import.meta.env.DEV && ["localhost", "127.0.0.1"].includes(window.location?.hostname ?? "");
    if (localMotionPreview) document.documentElement.setAttribute("data-auto-ai-force-motion", "true");
    const reducedMotion = (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false) && !localMotionPreview;
    if (shouldDisableLuxuryMotion(disabled, reducedMotion)) {
      revealImmediately(root);
      return;
    }

    const scroller = getScrollContainer(root);
    const previousOverflow = scroller?.style.overflowY ?? "";
    let context: { revert(): void } | undefined;
    let failOpenTimer: number | undefined;
    root.classList.add("luxury-cinematic-loading");
    if (scroller) scroller.style.overflowY = "hidden";

    const restoreScroll = () => {
      if (scroller) scroller.style.overflowY = previousOverflow;
    };

    try {
      const splitEase = CustomEase.create("autoAiLuxurySplit", LUXURY_CINEMATIC_CONFIG.splitEase);
      context = gsap.context(() => {
          const loader = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loader);
          const loaderTop = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderTop);
          const loaderBottom = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderBottom);
          const loaderMark = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderMark);
          const loaderGrid = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderGrid);
          const loaderBeam = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderBeam);
          const loaderProgress = root.querySelector<HTMLElement>(LUXURY_SELECTORS.loaderProgress);
          const loaderLetters = gsap.utils.toArray<HTMLElement>(LUXURY_SELECTORS.loaderLetter, root);
          const headingLines = gsap.utils.toArray<HTMLElement>(LUXURY_SELECTORS.headingLine, root);
          const headingWords = gsap.utils.toArray<HTMLElement>(LUXURY_SELECTORS.headingWord, root);
          const heroMedia = root.querySelector<HTMLElement>(`${LUXURY_SELECTORS.media}[data-luxury-media="hero"]`);
          const scrollMedia = gsap.utils.toArray<HTMLElement>(`${LUXURY_SELECTORS.media}:not([data-luxury-media="hero"])`, root);
          const parallaxTargets = gsap.utils.toArray<HTMLElement>(LUXURY_SELECTORS.parallax, root);
          const finishLoader = () => {
            if (failOpenTimer !== undefined) {
              window.clearTimeout(failOpenTimer);
              failOpenTimer = undefined;
            }
            if (loader) gsap.set(loader, { display: "none", pointerEvents: "none" });
            root.classList.remove("luxury-cinematic-loading");
            restoreScroll();
          };

          gsap.set(headingLines, { autoAlpha: 1 });
          gsap.set(headingWords, {
            autoAlpha: 0,
            yPercent: 135,
            rotateX: -88,
            rotateY: 16,
            filter: "blur(12px)",
            transformOrigin: "50% 100%"
          });
          if (heroMedia) gsap.set(heroMedia, { clipPath: LUXURY_CINEMATIC_CONFIG.collapsedClipPath });
          gsap.set(scrollMedia, { clipPath: LUXURY_CINEMATIC_CONFIG.collapsedClipPath });
          root.classList.add("luxury-cinematic-ready");

          const loadTimeline = gsap.timeline({
            defaults: { ease: splitEase },
            onComplete: () => {
              ScrollTrigger.refresh();
            }
          });

          if (loaderGrid) loadTimeline.fromTo(loaderGrid, { autoAlpha: 0, scale: 1.12 }, { autoAlpha: 0.72, scale: 1, duration: 0.72 }, 0);
          if (loaderBeam) loadTimeline.fromTo(loaderBeam, { scaleX: 0, autoAlpha: 0 }, { scaleX: 1, autoAlpha: 1, duration: 0.68 }, 0.08);
          if (loaderMark) loadTimeline.to(loaderMark, { autoAlpha: 1, y: 0, duration: 0.38 }, 0);
          loadTimeline.fromTo(loaderLetters, {
            autoAlpha: 0,
            yPercent: 115,
            rotateX: -84
          }, {
            autoAlpha: 1,
            yPercent: 0,
            rotateX: 0,
            duration: 0.64,
            stagger: 0.045
          }, 0.08);
          if (loaderProgress) {
            const progress = { value: 0 };
            loadTimeline.to(progress, {
              value: 100,
              duration: 1.08,
              ease: "power3.inOut",
              onUpdate: () => {
                loaderProgress.textContent = Math.round(progress.value).toString().padStart(3, "0");
              }
            }, 0.04);
          }
          if (loaderTop) loadTimeline.to(loaderTop, { yPercent: -101, duration: LUXURY_CINEMATIC_CONFIG.loaderDuration }, 0.28);
          if (loaderBottom) loadTimeline.to(loaderBottom, { yPercent: 101, duration: LUXURY_CINEMATIC_CONFIG.loaderDuration }, 0.28);
          if (loaderBeam) loadTimeline.to(loaderBeam, { scaleX: 0, autoAlpha: 0, duration: 0.52, transformOrigin: "100% 50%" }, 0.72);
          loadTimeline.call(finishLoader, [], 1.34);
          loadTimeline.to(headingWords, {
            autoAlpha: 1,
            yPercent: 0,
            rotateX: 0,
            rotateY: 0,
            filter: "blur(0px)",
            duration: LUXURY_CINEMATIC_CONFIG.headingDuration,
            stagger: 0.075
          }, 0.48);
          if (heroMedia) {
            loadTimeline.to(heroMedia, {
              clipPath: LUXURY_CINEMATIC_CONFIG.revealedClipPath,
              duration: LUXURY_CINEMATIC_CONFIG.mediaDuration
            }, 0.5);
          }

          // Native timeout guarantees that a backgrounded or throttled tab can never retain the loader.
          failOpenTimer = window.setTimeout(() => {
            if (!root.classList.contains("luxury-cinematic-loading")) return;
            loadTimeline.progress(1);
            finishLoader();
          }, 2800);

          scrollMedia.forEach((media) => {
            gsap.to(media, {
              clipPath: LUXURY_CINEMATIC_CONFIG.revealedClipPath,
              duration: LUXURY_CINEMATIC_CONFIG.mediaDuration,
              ease: splitEase,
              scrollTrigger: {
                trigger: media,
                scroller,
                start: LUXURY_CINEMATIC_CONFIG.mediaStart,
                toggleActions: "restart none restart reset",
                invalidateOnRefresh: true
              }
            });
          });

          const halfParallax = LUXURY_CINEMATIC_CONFIG.parallaxPercent / 2;
          parallaxTargets.forEach((target) => {
            const trigger = target.closest<HTMLElement>(LUXURY_SELECTORS.media) ?? target;
            // The -7.5% to +7.5% range produces the requested 15% total parallax travel.
            gsap.fromTo(target, { yPercent: -halfParallax }, {
              yPercent: halfParallax,
              ease: "none",
              scrollTrigger: {
                trigger,
                scroller,
                start: "top bottom",
                end: "bottom top",
                scrub: 0.65,
                invalidateOnRefresh: true
              }
            });
          });
      }, root);
    } catch {
      restoreScroll();
      revealImmediately(root);
    }

    return () => {
      if (failOpenTimer !== undefined) window.clearTimeout(failOpenTimer);
      restoreScroll();
      context?.revert();
      root.classList.remove("luxury-cinematic-loading", "luxury-cinematic-ready");
    };
  }, [disabled, rootRef]);
}
