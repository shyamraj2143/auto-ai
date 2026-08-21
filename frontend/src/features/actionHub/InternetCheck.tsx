import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, Download, Loader2, RefreshCw, Server, Signal, Upload, Wifi, WifiOff, X } from "lucide-react";

const API_BASE = "https://autoai.site.je/api/v1";
const SPEED_BASE = "https://speed.cloudflare.com";
const REQUEST_TIMEOUT_MS = 8000;

type Phase = "idle" | "checking" | "results";
type StepState = "pending" | "running" | "done" | "failed";

type Steps = {
  connection: StepState;
  download: StepState;
  upload: StepState;
  latency: StepState;
  server: StepState;
};

type Result = {
  connected: boolean;
  downloadMbps: number | null;
  uploadMbps: number | null;
  latencyMs: number | null;
  jitterMs: number | null;
  network: string;
  serverReachable: boolean;
  serverLatencyMs: number | null;
  checkedAt: Date;
};

const initialSteps: Steps = {
  connection: "pending",
  download: "pending",
  upload: "pending",
  latency: "pending",
  server: "pending",
};

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, signal?: AbortSignal) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
    return { response, elapsedMs: Math.max(1, performance.now() - started) };
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function networkLabel() {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number } }).connection;
  const type = connection?.effectiveType?.toUpperCase() || "ONLINE";
  const downlink = typeof connection?.downlink === "number" ? ` • ${connection.downlink.toFixed(1)} Mbps est.` : "";
  return `${type}${downlink}`;
}

function round(value: number | null, digits = 0) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function speedLabel(value: number | null) {
  if (value === null) return "Unavailable";
  if (value >= 25) return "Excellent";
  if (value >= 10) return "Very Good";
  if (value >= 5) return "Good";
  if (value >= 2) return "Fair";
  return "Slow";
}

function latencyLabel(value: number | null) {
  if (value === null) return "Unavailable";
  if (value <= 50) return "Excellent";
  if (value <= 100) return "Very Good";
  if (value <= 180) return "Good";
  if (value <= 300) return "Fair";
  return "High";
}

function StatusIcon({ state }: { state: StepState }) {
  if (state === "running") return <Loader2 size={16} className="animate-spin" />;
  if (state === "done") return <CheckCircle2 size={16} />;
  return null;
}

function StepRow({ icon, label, state }: { icon: React.ReactNode; label: string; state: StepState }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, minHeight: 48, padding: "0 4px", borderBottom: "1px solid rgba(255,255,255,.07)", color: "#eef2ff" }}>
      <span style={{ width: 22, display: "grid", placeItems: "center", color: state === "done" ? "#35e77a" : state === "failed" ? "#ff5b78" : "#aeb8cc" }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{label}</span>
      <span style={{ color: state === "done" ? "#35e77a" : state === "failed" ? "#ff5b78" : "#aeb8cc" }}><StatusIcon state={state} /></span>
    </div>
  );
}

function Metric({ icon, label, value, unit, quality }: { icon: React.ReactNode; label: string; value: string; unit?: string; quality?: string }) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0, padding: "16px 14px", border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, background: "rgba(255,255,255,.035)", textAlign: "center" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, color: "#9eaac0", fontSize: 11 }}>{icon}{label}</div>
      <div style={{ marginTop: 7, fontSize: 24, lineHeight: 1, fontWeight: 800, color: "#f7f8ff" }}>{value}{unit && <small style={{ marginLeft: 4, fontSize: 12, color: "#aeb8cc" }}>{unit}</small>}</div>
      {quality && <div style={{ marginTop: 8, color: "#35e77a", fontSize: 11, fontWeight: 700 }}>{quality}</div>}
    </div>
  );
}

export function InternetCheck() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [steps, setSteps] = useState<Steps>(initialSteps);
  const [result, setResult] = useState<Result | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setStep = useCallback((key: keyof Steps, state: StepState) => {
    setSteps((current) => ({ ...current, [key]: state }));
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
  }, []);

  const runTest = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("checking");
    setResult(null);
    setSteps(initialSteps);

    let internetConnected = false;
    let serverReachable = false;
    let serverLatencyMs: number | null = null;
    let downloadMbps: number | null = null;
    let uploadMbps: number | null = null;
    let latencyMs: number | null = null;
    let jitterMs: number | null = null;

    try {
      setStep("connection", "running");
      if (!navigator.onLine) throw new Error("offline");
      const connectionProbe = await fetchWithTimeout(`${SPEED_BASE}/__down?bytes=1&measId=${Date.now()}`, { method: "GET" }, controller.signal);
      internetConnected = connectionProbe.response.ok;
      setStep("connection", internetConnected ? "done" : "failed");
      if (!internetConnected) throw new Error("internet_unreachable");

      setStep("download", "running");
      try {
        const started = performance.now();
        const response = await fetch(`${SPEED_BASE}/__down?bytes=4000000&measId=${Date.now()}`, { cache: "no-store", credentials: "omit", signal: controller.signal });
        const buffer = await response.arrayBuffer();
        const seconds = Math.max((performance.now() - started) / 1000, 0.05);
        if (!response.ok || !buffer.byteLength) throw new Error("download_failed");
        downloadMbps = round((buffer.byteLength * 8) / seconds / 1_000_000, 1);
        setStep("download", "done");
      } catch {
        setStep("download", "failed");
      }

      setStep("upload", "running");
      try {
        const payload = new Uint8Array(1_000_000);
        const started = performance.now();
        const response = await fetch(`${SPEED_BASE}/__up?measId=${Date.now()}`, { method: "POST", body: payload, cache: "no-store", credentials: "omit", signal: controller.signal });
        const seconds = Math.max((performance.now() - started) / 1000, 0.05);
        if (!response.ok) throw new Error("upload_failed");
        uploadMbps = round((payload.byteLength * 8) / seconds / 1_000_000, 1);
        setStep("upload", "done");
      } catch {
        setStep("upload", "failed");
      }

      setStep("latency", "running");
      try {
        const samples: number[] = [];
        for (let index = 0; index < 5; index += 1) {
          const sample = await fetchWithTimeout(`${SPEED_BASE}/__down?bytes=0&measId=${Date.now()}-${index}`, { method: "GET" }, controller.signal);
          samples.push(sample.elapsedMs);
          await sleep(40);
        }
        const sorted = [...samples].sort((a, b) => a - b);
        latencyMs = round(sorted[Math.floor(sorted.length / 2)] ?? null);
        const diffs = samples.slice(1).map((value, index) => Math.abs(value - samples[index]));
        jitterMs = round(diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : 0);
        setStep("latency", "done");
      } catch {
        setStep("latency", "failed");
      }

      setStep("server", "running");
      try {
        const health = await fetchWithTimeout(`${API_BASE}/health`, { method: "GET" }, controller.signal);
        serverReachable = health.response.ok;
        serverLatencyMs = Math.round(health.elapsedMs);
        setStep("server", serverReachable ? "done" : "failed");
      } catch {
        setStep("server", "failed");
      }

      if (controller.signal.aborted) return;
      setResult({
        connected: internetConnected,
        downloadMbps,
        uploadMbps,
        latencyMs,
        jitterMs,
        network: networkLabel(),
        serverReachable,
        serverLatencyMs,
        checkedAt: new Date(),
      });
      setPhase("results");
    } catch {
      if (!controller.signal.aborted) {
        setStep("connection", "failed");
        setResult({ connected: false, downloadMbps, uploadMbps, latencyMs, jitterMs, network: networkLabel(), serverReachable, serverLatencyMs, checkedAt: new Date() });
        setPhase("results");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [setStep]);

  const openCheck = () => {
    setOpen(true);
    void runTest();
  };

  const close = () => {
    cancel();
    setOpen(false);
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <>
      <button type="button" className="hub-internet-check-button" onClick={openCheck} aria-label="Open Internet Check">
        <Wifi size={17} />
        <span>Internet Check</span>
      </button>

      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="internet-check-title" style={{ position: "fixed", inset: 0, zIndex: 200, display: "grid", placeItems: "center", padding: 18, background: "rgba(2,7,16,.72)", backdropFilter: "blur(8px)" }}>
          <div style={{ width: "min(100%, 520px)", maxHeight: "calc(100dvh - 36px)", overflow: "auto", color: "#eef2ff", border: "1px solid rgba(174,122,255,.42)", borderRadius: 24, background: "linear-gradient(145deg,#101b2d,#0b1423)", boxShadow: "0 30px 90px rgba(0,0,0,.55)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 22px 12px" }}>
              <h2 id="internet-check-title" style={{ margin: 0, fontSize: 19, fontWeight: 800 }}>Internet Check</h2>
              <button type="button" onClick={close} aria-label="Close Internet Check" style={{ display: "grid", width: 38, height: 38, placeItems: "center", color: "#dbe2f0", border: 0, borderRadius: 12, background: "rgba(255,255,255,.05)" }}><X size={20} /></button>
            </div>

            {phase === "checking" && (
              <div style={{ padding: "8px 22px 22px" }}>
                <div style={{ display: "grid", placeItems: "center", padding: "10px 0 20px" }}>
                  <div style={{ width: 128, height: 128, display: "grid", placeItems: "center", borderRadius: "50%", border: "1px solid rgba(165,95,255,.35)", boxShadow: "0 0 0 14px rgba(139,73,230,.06),0 0 0 28px rgba(139,73,230,.035)" }}>
                    <Wifi size={44} color="#d38cff" />
                  </div>
                  <strong style={{ marginTop: 20, fontSize: 17 }}>Checking your internet connection...</strong>
                  <span style={{ marginTop: 7, color: "#98a5bc", fontSize: 12 }}>Please wait while we test your connection</span>
                </div>
                <div style={{ overflow: "hidden", border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, background: "rgba(255,255,255,.025)" }}>
                  <StepRow icon={<Wifi size={16} />} label="Checking Connection" state={steps.connection} />
                  <StepRow icon={<Download size={16} />} label="Measuring Download Speed" state={steps.download} />
                  <StepRow icon={<Upload size={16} />} label="Measuring Upload Speed" state={steps.upload} />
                  <StepRow icon={<Clock3 size={16} />} label="Measuring Latency & Jitter" state={steps.latency} />
                  <StepRow icon={<Server size={16} />} label="Checking Server Connection" state={steps.server} />
                </div>
                <button type="button" onClick={close} style={{ width: "100%", minHeight: 48, marginTop: 18, color: "#d8b8ff", border: "1px solid rgba(174,122,255,.3)", borderRadius: 14, background: "rgba(125,70,222,.16)", fontWeight: 800 }}>Cancel</button>
              </div>
            )}

            {phase === "results" && result && (
              <div style={{ padding: "8px 22px 22px" }}>
                <div style={{ display: "grid", placeItems: "center", padding: "8px 0 20px", textAlign: "center" }}>
                  <div style={{ width: 72, height: 72, display: "grid", placeItems: "center", borderRadius: "50%", border: `2px solid ${result.connected ? "#35e77a" : "#ff5b78"}`, color: result.connected ? "#35e77a" : "#ff5b78", boxShadow: `0 0 30px ${result.connected ? "rgba(53,231,122,.16)" : "rgba(255,91,120,.16)"}` }}>
                    {result.connected ? <Wifi size={34} /> : <WifiOff size={34} />}
                  </div>
                  <strong style={{ marginTop: 14, color: result.connected ? "#35e77a" : "#ff5b78", fontSize: 18 }}>{result.connected ? "Internet Connected" : "Internet Unavailable"}</strong>
                  <span style={{ marginTop: 6, color: "#aab4c8", fontSize: 12 }}>{result.connected ? result.serverReachable ? "Your connection is stable and Auto-AI server is reachable." : "Internet is available, but Auto-AI server is unreachable." : "Check your network connection and try again."}</span>
                </div>

                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Metric icon={<Download size={14} />} label="Download" value={result.downloadMbps === null ? "—" : String(result.downloadMbps)} unit="Mbps" quality={speedLabel(result.downloadMbps)} />
                  <Metric icon={<Upload size={14} />} label="Upload" value={result.uploadMbps === null ? "—" : String(result.uploadMbps)} unit="Mbps" quality={speedLabel(result.uploadMbps)} />
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                  <Metric icon={<Clock3 size={14} />} label="Latency" value={result.latencyMs === null ? "—" : String(result.latencyMs)} unit="ms" quality={latencyLabel(result.latencyMs)} />
                  <Metric icon={<Signal size={14} />} label="Jitter" value={result.jitterMs === null ? "—" : String(result.jitterMs)} unit="ms" quality={latencyLabel(result.jitterMs)} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 8, marginTop: 10 }}>
                  <div style={{ padding: 12, borderRadius: 14, background: "rgba(255,255,255,.035)", textAlign: "center" }}><small style={{ color: "#8f9bb1" }}>Network</small><strong style={{ display: "block", marginTop: 4, fontSize: 12 }}>{result.network}</strong></div>
                  <div style={{ padding: 12, borderRadius: 14, background: "rgba(255,255,255,.035)", textAlign: "center" }}><small style={{ color: "#8f9bb1" }}>Server</small><strong style={{ display: "block", marginTop: 4, fontSize: 12, color: result.serverReachable ? "#35e77a" : "#ff5b78" }}>{result.serverReachable ? "AutoAI Server" : "Unreachable"}</strong></div>
                  <div style={{ padding: 12, borderRadius: 14, background: "rgba(255,255,255,.035)", textAlign: "center" }}><small style={{ color: "#8f9bb1" }}>Time</small><strong style={{ display: "block", marginTop: 4, fontSize: 12 }}>{result.checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</strong></div>
                </div>

                <div style={{ marginTop: 12, padding: 14, borderRadius: 15, border: "1px solid rgba(53,231,122,.12)", background: "rgba(53,231,122,.045)" }}>
                  <strong style={{ display: "block", color: result.connected && result.serverReachable ? "#35e77a" : "#ffb45b", fontSize: 13 }}>{result.connected && result.serverReachable ? "Good Connection" : result.connected ? "Server Connection Issue" : "No Internet Connection"}</strong>
                  <span style={{ display: "block", marginTop: 4, color: "#aab4c8", fontSize: 11, lineHeight: 1.5 }}>{result.connected && result.serverReachable ? "You can browse, stream, chat and make calls." : result.connected ? "Your internet works, but Auto-AI server is currently not reachable." : "Reconnect to the internet and run the check again."}</span>
                </div>

                <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                  <button type="button" onClick={() => void runTest()} style={{ flex: 1, minHeight: 48, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#d8b8ff", border: "1px solid rgba(174,122,255,.38)", borderRadius: 14, background: "rgba(125,70,222,.12)", fontWeight: 800 }}><RefreshCw size={16} /> Check Again</button>
                  <button type="button" onClick={close} style={{ flex: 1, minHeight: 48, color: "#fff", border: 0, borderRadius: 14, background: "linear-gradient(135deg,#7f43e8,#5f35ca)", fontWeight: 800 }}>Close</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
