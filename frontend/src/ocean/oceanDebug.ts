export type OceanDebugRenderer = "pending" | "webgl" | "fallback" | "reduced";
export type OceanDebugShaderStatus = "pending" | "success" | "failure";

export type OceanDebugSnapshot = {
  mounted: boolean;
  renderer: OceanDebugRenderer;
  shaderStatus: OceanDebugShaderStatus;
  state: string;
  frameCount: number;
  reducedMotion: boolean;
  quality: string;
  canvasSize: { width: number; height: number };
  canvasBoundsValid: boolean;
  lastError: string | null;
};

const initialSnapshot: OceanDebugSnapshot = {
  mounted: false,
  renderer: "pending",
  shaderStatus: "pending",
  state: "home-calm",
  frameCount: 0,
  reducedMotion: false,
  quality: "pending",
  canvasSize: { width: 0, height: 0 },
  canvasBoundsValid: false,
  lastError: null
};

declare global {
  interface Window {
    __AUTOAI_OCEAN_DEBUG__?: OceanDebugSnapshot;
  }
}

let didLogDebugSnapshot = false;

export function isOceanDebugEnabled() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("oceanDebug") === "1";
}

export function oceanDebugStateLabel(state: string) {
  return state === "idle" ? "home-calm" : state;
}

export function updateOceanDebug(patch: Partial<OceanDebugSnapshot>) {
  if (!isOceanDebugEnabled()) return;
  window.__AUTOAI_OCEAN_DEBUG__ = {
    ...initialSnapshot,
    ...window.__AUTOAI_OCEAN_DEBUG__,
    ...patch
  };
}

export function logOceanDebugSnapshot() {
  if (!isOceanDebugEnabled() || didLogDebugSnapshot) return;
  didLogDebugSnapshot = true;
  console.info("[Auto-AI Ocean Debug]", window.__AUTOAI_OCEAN_DEBUG__);
}
