import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupKineticReveal } from "./useKineticReveal";

class FakeClassList {
  private readonly values = new Set<string>();
  add(...tokens: string[]) { tokens.forEach((token) => this.values.add(token)); }
  remove(...tokens: string[]) { tokens.forEach((token) => this.values.delete(token)); }
  contains(token: string) { return this.values.has(token); }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly targets: FakeElement[] = [];
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  parentElement: FakeElement | null = null;
  revealTarget = false;
  rectTop = 0;
  rectBottom = 100;
  scrollHeight = 100;
  clientHeight = 100;
  offsetWidthReads = 0;

  get offsetWidth() { this.offsetWidthReads += 1; return 100; }
  matches() { return this.revealTarget; }
  querySelectorAll<T extends Element>() { return this.targets as unknown as NodeListOf<T>; }
  getBoundingClientRect() { return { top: this.rectTop, bottom: this.rectBottom } as DOMRect; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    this.listeners.get(type)?.forEach((listener) => {
      if (typeof listener === "function") listener({ type } as Event);
      else listener.handleEvent({ type } as Event);
    });
  }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  unobserveCount = 0;

  constructor(private readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.unobserveCount += 1; this.observed.delete(element); }
  disconnect() { this.disconnected = true; this.observed.clear(); }
  trigger(element: FakeElement, isIntersecting = true) {
    this.callback([{
      isIntersecting,
      target: element,
      boundingClientRect: element.getBoundingClientRect()
    } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  disconnected = false;
  constructor(_callback: MutationCallback) { FakeMutationObserver.instances.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
}

function installBrowserGlobals({ reducedMotion = false, editorDisabled = false } = {}) {
  const windowListeners = new Map<string, EventListener>();
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    matches: reducedMotion,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener)
  };
  const browserWindow = {
    IntersectionObserver: FakeIntersectionObserver,
    MutationObserver: FakeMutationObserver,
    innerWidth: 1280,
    matchMedia: () => mediaQuery,
    getComputedStyle: (element: FakeElement) => ({ overflowY: element.scrollHeight > element.clientHeight ? "auto" : "visible" }),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: (type: string, listener: EventListener) => windowListeners.set(type, listener),
    removeEventListener: (type: string) => windowListeners.delete(type)
  };

  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", {
    visibilityState: "hidden",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal("navigator", { deviceMemory: 8, hardwareConcurrency: 8, connection: { saveData: false } });
  vi.stubGlobal("performance", { getEntriesByType: () => [{ type: "navigate" }] });
  return { editorDisabled };
}

function createScope() {
  const scrollContainer = new FakeElement();
  scrollContainer.scrollHeight = 2000;
  scrollContainer.clientHeight = 800;
  const root = new FakeElement();
  root.parentElement = scrollContainer;
  const target = new FakeElement();
  target.revealTarget = true;
  root.targets.push(target);
  return { root, target, scrollContainer };
}

describe("setupKineticReveal", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    FakeMutationObserver.instances = [];
  });

  afterEach(() => vi.unstubAllGlobals());

  it("replays on every viewport re-entry and keeps observing the element", () => {
    installBrowserGlobals();
    const { root, target, scrollContainer } = createScope();
    const cleanup = setupKineticReveal(root as unknown as HTMLElement);
    const observer = FakeIntersectionObserver.instances[0];

    expect(root.classList.contains("kinetic-motion-ready")).toBe(true);
    expect(observer.options).toMatchObject({ threshold: 0.12, rootMargin: "0px 0px -2% 0px" });
    expect(observer.options?.root).toBe(scrollContainer);
    observer.trigger(target);

    expect(target.classList.contains("is-revealed")).toBe(true);
    expect(target.classList.contains("is-kinetic-complete")).toBe(true);
    expect(target.offsetWidthReads).toBe(0);

    observer.trigger(target, false);
    observer.trigger(target, true);

    expect(target.classList.contains("is-revealed")).toBe(true);
    expect(target.classList.contains("is-kinetic-complete")).toBe(true);
    expect(target.offsetWidthReads).toBe(1);
    expect(observer.unobserveCount).toBe(0);
    expect(observer.observed.size).toBe(1);
    cleanup?.();
  });

  it("reveals skipped targets at scrollend after a fast scroll", () => {
    installBrowserGlobals();
    const { root, target, scrollContainer } = createScope();
    const cleanup = setupKineticReveal(root as unknown as HTMLElement);
    target.rectBottom = -20;

    scrollContainer.dispatch("scrollend");

    expect(target.classList.contains("is-revealed")).toBe(true);
    expect(target.classList.contains("is-kinetic-complete")).toBe(true);
    expect(FakeIntersectionObserver.instances[0].observed.size).toBe(1);
    cleanup?.();
  });

  it("uses the passive scroll fallback when IntersectionObserver misses a visible target", () => {
    vi.useFakeTimers();
    installBrowserGlobals();
    const { root, target, scrollContainer } = createScope();
    const cleanup = setupKineticReveal(root as unknown as HTMLElement);
    target.rectTop = 20;
    target.rectBottom = 70;

    scrollContainer.dispatch("scroll");
    vi.advanceTimersByTime(50);

    expect(target.classList.contains("is-revealed")).toBe(true);
    cleanup?.();
    vi.useRealTimers();
  });

  it("disconnects observers and removes the scrollend listener on cleanup", () => {
    installBrowserGlobals();
    const { root, scrollContainer } = createScope();
    const cleanup = setupKineticReveal(root as unknown as HTMLElement);

    expect(scrollContainer.listeners.get("scrollend")?.size).toBe(1);
    expect(scrollContainer.listeners.get("scroll")?.size).toBe(1);
    cleanup?.();

    expect(FakeIntersectionObserver.instances[0].disconnected).toBe(true);
    expect(FakeMutationObserver.instances[0].disconnected).toBe(true);
    expect(scrollContainer.listeners.get("scrollend")?.size).toBe(0);
    expect(scrollContainer.listeners.get("scroll")?.size).toBe(0);
    expect(root.classList.contains("kinetic-motion-ready")).toBe(false);
  });

  it("keeps everything visible for reduced motion and the interactive editor", () => {
    installBrowserGlobals({ reducedMotion: true });
    const reducedScope = createScope();
    setupKineticReveal(reducedScope.root as unknown as HTMLElement);
    expect(reducedScope.target.classList.contains("is-kinetic-complete")).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);

    vi.unstubAllGlobals();
    installBrowserGlobals();
    const editorScope = createScope();
    setupKineticReveal(editorScope.root as unknown as HTMLElement, { disabled: true });
    expect(editorScope.target.classList.contains("is-kinetic-complete")).toBe(true);
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it("fails open when observer construction fails", () => {
    installBrowserGlobals();
    const { root, target } = createScope();
    vi.stubGlobal("IntersectionObserver", class { constructor() { throw new Error("observer unavailable"); } });

    const cleanup = setupKineticReveal(root as unknown as HTMLElement);

    expect(root.classList.contains("kinetic-motion-ready")).toBe(false);
    expect(target.classList.contains("is-kinetic-complete")).toBe(true);
    cleanup?.();
  });
});
