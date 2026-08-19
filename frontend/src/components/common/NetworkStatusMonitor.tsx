import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CloudOff, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";

type NetworkState = "checking" | "good" | "slow" | "poor" | "offline" | "backend_unreachable";
type ConnectionInfo = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  type?: string;
};

type NetworkInformationLike = EventTarget & ConnectionInfo;

type Diagnostics = {
  state: NetworkState;
  latencyMs: number | null;
  downlinkMbps: number | null;
  effectiveType: string | null;
  backendReachable: boolean | null;
  checkedAt: number;
};

const API_BASE = "https://autoai.site.je/api/v1";
const INTERNET_PROBE = "https://connectivitycheck.gstatic.com/generate_204";
const PRESENCE_INTERVAL_MS = 15_000;
const NETWORK_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 4_500;

function connectionInfo(): ConnectionInfo {
  if (typeof navigator === "undefined") return {};
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!connection) return {};
  return {
    effectiveType: connection.effectiveType,
    downlink: typeof connection.downlink === "number" ? connection.downlink : undefined,
    rtt: typeof connection.rtt === "number" ? connection.rtt : undefined,
    type: connection.type,
  };
}

async function timedFetch(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    return { ok: response.ok || response.type === "opaque", latencyMs: Math.round(performance.now() - started) };
  } finally {
    window.clearTimeout(timer);
  }
}

function classifyNetwork(info: ConnectionInfo, latencyMs: number | null, backendReachable: boolean): NetworkState {
  if (!navigator.onLine) return "offline";
  if (!backendReachable) return "backend_unreachable";
  const type = String(info.effectiveType || "").toLowerCase();
  const downlink = typeof info.downlink === "number" ? info.downlink : null;
  const rtt = typeof info.rtt === "number" ? info.rtt : latencyMs;
  if (type === "slow-2g" || type === "2g" || (downlink !== null && downlink < 0.5) || (rtt !== null && rtt > 1500)) return "poor";
  if (type === "3g" || (downlink !== null && downlink < 1.5) || (rtt !== null && rtt > 800)) return "slow";
  return "good";
}

async function measureNetwork(): Promise<Diagnostics> {
  const info = connectionInfo();
  if (!navigator.onLine) {
    return { state: "offline", latencyMs: null, downlinkMbps: info.downlink ?? null, effectiveType: info.effectiveType ?? null, backendReachable: false, checkedAt: Date.now() };
  }

  let internetReachable = false;
  let latencyMs: number | null = null;
  try {
    const result = await timedFetch(INTERNET_PROBE, { method: "GET", mode: "no-cors" });
    internetReachable = result.ok;
  } catch {
    internetReachable = false;
  }

  let backendReachable = false;
  try {
    const result = await timedFetch(`${API_BASE}/health`, { method: "GET" });
    backendReachable = result.ok;
    latencyMs = result.latencyMs;
  } catch {
    backendReachable = false;
  }

  if (!internetReachable) {
    return { state: "offline", latencyMs, downlinkMbps: info.downlink ?? null, effectiveType: info.effectiveType ?? null, backendReachable, checkedAt: Date.now() };
  }

  return {
    state: classifyNetwork(info, latencyMs, backendReachable),
    latencyMs,
    downlinkMbps: info.downlink ?? null,
    effectiveType: info.effectiveType ?? null,
    backendReachable,
    checkedAt: Date.now(),
  };
}

function statusText(diagnostics: Diagnostics) {
  switch (diagnostics.state) {
    case "offline": return "Internet connection नहीं है";
    case "backend_unreachable": return "Internet है, लेकिन Auto-AI server तक connection नहीं हो रहा";
    case "poor": return "Internet बहुत slow है";
    case "slow": return "Internet slow है";
    case "checking": return "Network check हो रहा है…";
    default: return "Internet connection ठीक है";
  }
}

function statusDetail(diagnostics: Diagnostics) {
  const parts: string[] = [];
  if (diagnostics.effectiveType) parts.push(diagnostics.effectiveType.toUpperCase());
  if (diagnostics.downlinkMbps !== null) parts.push(`${diagnostics.downlinkMbps.toFixed(1)} Mbps`);
  if (diagnostics.latencyMs !== null) parts.push(`${diagnostics.latencyMs} ms`);
  return parts.join(" • ");
}

export function NetworkStatusMonitor() {
  const { token } = useAuth();
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({ state: "checking", latencyMs: null, downlinkMbps: null, effectiveType: null, backendReachable: null, checkedAt: 0 });
  const [retrying, setRetrying] = useState(false);

  const publishPresence = useCallback(async (state: "foreground" | "background") => {
    if (!token) return;
    try {
      await fetch(`${API_BASE}/notifications/presence`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
        keepalive: state === "background",
      });
    } catch {
      // Presence is advisory; it must never block chat or notifications.
    }
  }, [token]);

  const refresh = useCallback(async () => {
    setRetrying(true);
    try {
      setDiagnostics(await measureNetwork());
    } finally {
      setRetrying(false);
    }
  }, []);

  useEffect(() => {
    void publishPresence(document.hidden ? "background" : "foreground");
    const timer = window.setInterval(() => void publishPresence(document.hidden ? "background" : "foreground"), PRESENCE_INTERVAL_MS);
    const onVisibility = () => void publishPresence(document.hidden ? "background" : "foreground");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      void publishPresence("background");
    };
  }, [publishPresence]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), NETWORK_INTERVAL_MS);
    const onNetworkChange = () => void refresh();
    window.addEventListener("online", onNetworkChange);
    window.addEventListener("offline", onNetworkChange);
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    connection?.addEventListener("change", onNetworkChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onNetworkChange);
      window.removeEventListener("offline", onNetworkChange);
      connection?.removeEventListener("change", onNetworkChange);
    };
  }, [refresh]);

  const visible = diagnostics.state !== "good" && diagnostics.state !== "checking";
  const Icon = diagnostics.state === "offline" ? WifiOff : diagnostics.state === "backend_unreachable" ? CloudOff : AlertTriangle;
  const detail = useMemo(() => statusDetail(diagnostics), [diagnostics]);
  if (!visible) return null;

  return (
    <div role="status" aria-live="polite" style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 62px)", left: 12, right: 12, zIndex: 120, display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 14, border: "1px solid rgba(255,255,255,.16)", background: "rgba(11,18,32,.94)", backdropFilter: "blur(14px)", boxShadow: "0 10px 30px rgba(0,0,0,.28)", color: "#eef2ff", fontSize: 12 }}>
      <Icon size={17} aria-hidden="true" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 700 }}>{statusText(diagnostics)}</div>
        {detail && <div style={{ opacity: .68, marginTop: 2 }}>{detail}</div>}
      </div>
      <button type="button" onClick={() => void refresh()} disabled={retrying} aria-label="Check network again" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 10, border: "1px solid rgba(255,255,255,.14)", background: "rgba(255,255,255,.06)", color: "inherit" }}>
        {retrying ? <RefreshCw size={15} className="animate-spin" /> : <Wifi size={15} />}
      </button>
    </div>
  );
}
