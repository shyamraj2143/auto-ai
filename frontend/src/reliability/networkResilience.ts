const DEBOUNCE_WINDOW_MS = 250;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const IN_FLIGHT_TTL_MS = 5_000;

const inFlight = new Map<string, { promise: Promise<Response>; startedAt: number }>();
const recentStarts = new Map<string, number>();
const patchedFetch = Symbol("autoAiResilientFetch");

type ResilientWindow = Window & { [patchedFetch]?: boolean };

function sleep(ms: number, signal?: AbortSignal | null) {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isStreamingRequest(init: RequestInit) {
  const accept = new Headers(init.headers).get("Accept") || "";
  return /text\/event-stream|application\/x-ndjson/i.test(accept);
}

function requestKey(input: RequestInfo | URL, init: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init.method || (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init.headers);
  return `${method} ${url} ${headers.get("Authorization") || ""}`;
}

function retryAfterMs(response: Response) {
  const header = response.headers.get("Retry-After");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(MAX_BACKOFF_MS, Math.max(0, date - Date.now()));
  return 0;
}

function backoffMs(attempt: number) {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** attempt));
  const jitter = Math.floor(Math.random() * Math.min(350, exponential * 0.25));
  return Math.min(MAX_BACKOFF_MS, exponential + jitter);
}

function shouldRetry(response: Response, method: string) {
  if (!isSafeMethod(method)) return false;
  return response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
}

async function performFetch(input: RequestInfo | URL, init: RequestInit, method: string) {
  const signal = init.signal;
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");

    const response = await window.fetch(input, init);
    if (!shouldRetry(response, method) || attempt >= MAX_RETRIES) return response;

    const retryDelay = response.status === 429
      ? Math.max(retryAfterMs(response), backoffMs(attempt))
      : backoffMs(attempt);

    response.body?.cancel().catch(() => undefined);
    await sleep(retryDelay, signal);
  }
}

export function installNetworkResilience() {
  if (typeof window === "undefined") return;
  const win = window as ResilientWindow;
  if (win[patchedFetch]) return;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method || (typeof input === "string" || input instanceof URL ? "GET" : input.method || "GET")).toUpperCase();
    const safe = isSafeMethod(method);
    const stream = isStreamingRequest(init);
    if (!safe || stream) return nativeFetch(input, init);

    const key = requestKey(input, init);
    const existing = inFlight.get(key);
    if (existing && Date.now() - existing.startedAt < IN_FLIGHT_TTL_MS) {
      const response = await existing.promise;
      return response.clone();
    }

    const previousStart = recentStarts.get(key) || 0;
    const waitMs = Math.max(0, DEBOUNCE_WINDOW_MS - (Date.now() - previousStart));
    if (waitMs > 0) await sleep(waitMs, init.signal);
    recentStarts.set(key, Date.now());

    const promise = performFetch(input, init, method);
    inFlight.set(key, { promise, startedAt: Date.now() });
    try {
      const response = await promise;
      return response.clone();
    } finally {
      window.setTimeout(() => {
        const current = inFlight.get(key);
        if (current?.promise === promise) inFlight.delete(key);
      }, 0);
    }
  };
  win[patchedFetch] = true;
}

function applyNativeLazyLoading(root: ParentNode = document) {
  root.querySelectorAll<HTMLImageElement>("img:not([loading])").forEach((image) => {
    if (image.dataset.critical !== "true") image.loading = "lazy";
  });
  root.querySelectorAll<HTMLIFrameElement>("iframe:not([loading])").forEach((frame) => {
    frame.loading = "lazy";
  });
}

export function installLazyLoading() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  applyNativeLazyLoading(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        applyNativeLazyLoading(node as Element);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.setTimeout(() => observer.disconnect(), 30_000);
}

installNetworkResilience();
installLazyLoading();
