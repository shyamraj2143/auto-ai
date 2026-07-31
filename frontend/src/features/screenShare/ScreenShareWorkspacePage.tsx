import { ArrowDownToLine, Copy, MonitorUp, Radio, ShieldCheck, Users, Wifi } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useScreenShare } from "./useScreenShare";

export function ScreenShareWorkspacePage() {
  const navigate = useNavigate();
  const screenShare = useScreenShare();
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const sessionCode = screenShare.shareCode || screenShare.session?.sessionId || screenShare.session?.session_id || "";
  const active = Boolean(screenShare.session);

  async function join() {
    const normalized = code.trim();
    if (!normalized) return;
    await screenShare.joinWithCode(normalized);
  }

  async function startSharing() {
    if (starting || active) return;
    setStarting(true);
    try {
      await screenShare.generateShareCode();
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="autoai-feature-page screen-share-workspace">
      <header className="autoai-feature-header">
        <span>
          <small>AutoAI workspace</small>
          <h1>Screen Sharing</h1>
          <p>Share, collaborate and solve problems together.</p>
        </span>
        <button type="button" onClick={() => navigate("/settings?section=screen-share")}>Share settings</button>
      </header>
      <section className="screen-share-hero-card">
        <div className="screen-share-visual"><MonitorUp size={54} /><i /></div>
        <div>
          <span className={`feature-live-pill ${active ? "active" : ""}`}><Radio size={13} /> {active ? screenShare.uiState : "Ready"}</span>
          <h2>{active ? "Screen session active" : "Start a secure screen session"}</h2>
          <p>Use the existing AutoAI encrypted room flow. The same code supports mobile and desktop viewers.</p>
          <div className="screen-share-primary-actions">
            <button type="button" onClick={() => void startSharing()} disabled={starting || active}><MonitorUp size={18} /> {starting ? "Starting..." : "Share my screen"}</button>
            {active && <button type="button" className="secondary" onClick={() => void screenShare.stopShare()}><ArrowDownToLine size={18} /> Stop sharing</button>}
          </div>
        </div>
      </section>
      <section className="screen-share-grid">
        <article className="autoai-glass-panel">
          <span className="panel-icon cyan"><Users size={22} /></span>
          <h3>Join a screen</h3>
          <p>Enter the code shared by another AutoAI user.</p>
          <label><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Enter share code" /><button type="button" onClick={() => void join()}>Join</button></label>
        </article>
        <article className="autoai-glass-panel">
          <span className="panel-icon violet"><Copy size={22} /></span>
          <h3>Current room code</h3>
          <p>{sessionCode || "Start sharing to generate a secure code."}</p>
          <button type="button" disabled={!sessionCode} onClick={() => void navigator.clipboard.writeText(sessionCode)}>Copy code</button>
        </article>
        <article className="autoai-glass-panel">
          <span className="panel-icon green"><Wifi size={22} /></span>
          <h3>Connection</h3>
          <p>{screenShare.networkQuality === "unknown" ? "Secure relay ready" : `${screenShare.networkQuality} network quality`}</p>
          <small><ShieldCheck size={14} /> Permission is requested only when sharing starts.</small>
        </article>
      </section>
    </main>
  );
}
