import { useEffect, type RefObject } from "react";
import { KINETIC_REVEAL_COMPLETE_MS, isSimpleKineticDevice } from "../motion/kineticRevealConfig";

const REVEAL_SELECTOR = "[data-kinetic-reveal]";

type NavigatorPerformanceProfile = Navigator & {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
};

function revealImmediately(element: HTMLElement) {
  element.classList.add("is-revealed", "is-kinetic-complete");
}

function revealAll(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR).forEach(revealImmediately);
}

function isBackForwardRestore() {
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return navigation?.type === "back_forward";
  } catch {
    return false;
  }
}

function findScrollContainer(root: HTMLElement): HTMLElement | Document {
  try {
    let candidate = root.parentElement;
    while (candidate) {
      if (candidate.id === "root") return candidate;
      const overflowY = window.getComputedStyle(candidate).overflowY;
      const scrollableOverflow = overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden";
      if (scrollableOverflow && candidate.scrollHeight > candidate.clientHeight) return candidate;
      candidate = candidate.parentElement;
    }
  } catch {
    // Fall through to the document without blocking progressive enhancement.
  }
  return document;
}

function scrollBounds(target: HTMLElement | Document) {
  if (!(target instanceof HTMLElement)) return { top: 0, bottom: window.innerHeight };
  const bounds = target.getBoundingClientRect();
  return { top: bounds.top, bottom: bounds.bottom };
}

export function setupKineticReveal(root: HTMLElement, { disabled = false }: { disabled?: boolean } = {}) {
  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const localMotionPreview = import.meta.env.DEV && ["localhost", "127.0.0.1"].includes(window.location?.hostname ?? "");
  if (localMotionPreview) document.documentElement?.setAttribute("data-auto-ai-force-motion", "true");
  const reducedMotion = (motionQuery?.matches ?? false) && !localMotionPreview;
  const supported = "IntersectionObserver" in window && "MutationObserver" in window;
  if (disabled || reducedMotion || !supported || isBackForwardRestore()) {
    root.classList.remove("kinetic-motion-ready", "kinetic-motion-simple");
    revealAll(root);
    return undefined;
  }

  const observed = new Set<HTMLElement>();
  const visibleTargets = new Set<HTMLElement>();
  const completionTimers = new Map<HTMLElement, number>();
  const scrollContainer = findScrollContainer(root);
  const prismPortal = (() => {
    if (typeof document.createElement !== "function") return null;
    const portal = document.createElement("div");
    portal.className = "kinetic-prism-portal";
    portal.setAttribute("aria-hidden", "true");
    ["cyan", "violet", "pink"].forEach((tone) => {
      const blade = document.createElement("i");
      blade.className = `kinetic-prism-blade is-${tone}`;
      portal.appendChild(blade);
    });
    root.appendChild(portal);
    return portal;
  })();
  let disposed = false;
  let mutationObserver: MutationObserver | null = null;
  let observer: IntersectionObserver | null = null;
  let scrollFallbackTimer: number | undefined;

  const clearCompletionTimer = (element: HTMLElement) => {
    const timer = completionTimers.get(element);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    completionTimers.delete(element);
  };

  const triggerPrismPortal = (element: HTMLElement) => {
    if (!prismPortal || !element.matches("h1, h2, h3")) return;
    const rect = element.getBoundingClientRect();
    prismPortal.style.setProperty("--prism-portal-y", `${Math.max(80, Math.min(window.innerHeight - 80, rect.top + rect.height / 2))}px`);
    prismPortal.classList.remove("is-active");
    void prismPortal.offsetWidth;
    prismPortal.classList.add("is-active");
  };

  const finishReveal = (element: HTMLElement, animate = true, replay = false) => {
    if (element.classList.contains("is-revealed")) {
      if (!replay) return;
      clearCompletionTimer(element);
      element.classList.remove("is-revealed", "is-kinetic-complete");
      void element.offsetWidth;
    }
    element.classList.add("is-revealed");
    if (animate) triggerPrismPortal(element);
    if (!animate || document.visibilityState !== "visible") {
      element.classList.add("is-kinetic-complete");
      return;
    }
    const timer = window.setTimeout(() => {
      completionTimers.delete(element);
      element.classList.add("is-kinetic-complete");
    }, KINETIC_REVEAL_COMPLETE_MS);
    completionTimers.set(element, timer);
  };

  const failOpen = () => {
    root.classList.remove("kinetic-motion-ready", "kinetic-motion-simple");
    revealAll(root);
    observer?.disconnect();
    mutationObserver?.disconnect();
  };

  const revealPassedTargets = () => {
    try {
      const bounds = scrollBounds(scrollContainer);
      observed.forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > bounds.top + 1) return;
        finishReveal(element, false);
      });
    } catch {
      failOpen();
    }
  };

  const revealVisibleTargets = () => {
    try {
      const bounds = scrollBounds(scrollContainer);
      const activationBottom = bounds.bottom - Math.max(12, (bounds.bottom - bounds.top) * 0.02);
      observed.forEach((element) => {
        const rect = element.getBoundingClientRect();
        const visible = rect.bottom > bounds.top && rect.top < activationBottom;
        if (!visible) {
          visibleTargets.delete(element);
          return;
        }
        if (visibleTargets.has(element)) return;
        visibleTargets.add(element);
        finishReveal(element, true, true);
      });
    } catch {
      failOpen();
    }
  };

  const handleScroll = () => {
    if (scrollFallbackTimer !== undefined) return;
    scrollFallbackTimer = window.setTimeout(() => {
      scrollFallbackTimer = undefined;
      revealVisibleTargets();
    }, 48);
  };

  try {
    observer = new IntersectionObserver((entries) => {
      if (disposed) return;
      const boundary = scrollBounds(scrollContainer).top + 1;
      entries.forEach((entry) => {
        const element = entry.target as HTMLElement;
        const passedViewport = entry.boundingClientRect.bottom <= boundary;
        if (!entry.isIntersecting) {
          visibleTargets.delete(element);
          if (!passedViewport) return;
          finishReveal(element, false);
          return;
        }
        if (visibleTargets.has(element)) return;
        visibleTargets.add(element);
        finishReveal(element, true, true);
      });
    }, {
      threshold: 0.12,
      rootMargin: "0px 0px -2% 0px",
      root: scrollContainer instanceof HTMLElement ? scrollContainer : null
    });

    const observeElement = (element: HTMLElement) => {
      if (observed.has(element)) return;
      if (element.matches("h1, h2, h3") && "dataset" in element) {
        element.dataset.kineticEcho = (element.textContent ?? "").trim().slice(0, 180);
      }
      observed.add(element);
      observer?.observe(element);
    };

    const collectTargets = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.matches(REVEAL_SELECTOR)) observeElement(node);
      node.querySelectorAll<HTMLElement>(REVEAL_SELECTOR).forEach(observeElement);
    };

    root.querySelectorAll<HTMLElement>(REVEAL_SELECTOR).forEach(observeElement);
    const profile = navigator as NavigatorPerformanceProfile;
    if (isSimpleKineticDevice({
      width: window.innerWidth,
      memoryGb: profile.deviceMemory,
      cores: profile.hardwareConcurrency,
      saveData: profile.connection?.saveData
    })) {
      root.classList.add("kinetic-motion-simple");
    }
    root.classList.add("kinetic-motion-ready");

    mutationObserver = new MutationObserver((records) => {
      try {
        records.forEach((record) => record.addedNodes.forEach(collectTargets));
      } catch {
        failOpen();
      }
    });
    mutationObserver.observe(root, { childList: true, subtree: true });
  } catch {
    failOpen();
  }

  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted) failOpen();
  };
  const handleMotionChange = (event: MediaQueryListEvent) => {
    if (event.matches) failOpen();
  };

  window.addEventListener("pageshow", handlePageShow);
  scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
  scrollContainer.addEventListener("scrollend", revealPassedTargets);
  motionQuery?.addEventListener?.("change", handleMotionChange);
  handleScroll();

  return () => {
    disposed = true;
    window.removeEventListener("pageshow", handlePageShow);
    scrollContainer.removeEventListener("scroll", handleScroll);
    scrollContainer.removeEventListener("scrollend", revealPassedTargets);
    motionQuery?.removeEventListener?.("change", handleMotionChange);
    observer?.disconnect();
    mutationObserver?.disconnect();
    completionTimers.forEach((timer) => window.clearTimeout(timer));
    if (scrollFallbackTimer !== undefined) window.clearTimeout(scrollFallbackTimer);
    completionTimers.clear();
    visibleTargets.clear();
    prismPortal?.remove();
    root.classList.remove("kinetic-motion-ready", "kinetic-motion-simple");
  };
}

export function useKineticReveal(
  rootRef: RefObject<HTMLElement>,
  { disabled = false }: { disabled?: boolean } = {}
) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return setupKineticReveal(root, { disabled });
  }, [disabled, rootRef]);
}
