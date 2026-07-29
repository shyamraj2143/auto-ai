import { ChevronDown, ChevronUp, Clipboard, GripHorizontal, Hash, LogIn, Monitor, Mic, MicOff, Pause, Play, ScreenShare, Square, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { AppSelect } from "../../components/common/AppSelect";
import { ScreenShareViewer } from "./ScreenShareViewer";
import { useScreenShare } from "./useScreenShare";
import type { ScreenShareQualityMode } from "./types";
import { useFloatingPanel } from "../media/useFloatingPanel";

function AudioSurface({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    const audioTracks = stream?.getAudioTracks() ?? [];
    const audioStream = audioTracks.length ? new MediaStream(audioTracks) : null;
    if (audio.srcObject !== audioStream) audio.srcObject = audioStream;
    if (audioStream) void audio.play().catch(() => undefined);
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

function formatDuration(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return "00:00";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

export function ScreenShareOverlay() {
  const share = useScreenShare();
  const duration = formatDuration(share.startedAt);
  const inviteAvatar = resolveApiAssetUrl(share.pendingInvite?.sharer.avatar_url);
  const active = share.uiState !== "idle" && share.uiState !== "ended";
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [codeExpanded, setCodeExpanded] = useState(false);
  const collapseTimerRef = useRef<number>(0);
  const dock = useFloatingPanel({ storageKey: "autoai.screen-share.dock.anchor", defaultAnchor: "bottom-center", bottomInset: 18 });

  function keepDockOpen() {
    window.clearTimeout(collapseTimerRef.current);
    if (dockCollapsed) setDockCollapsed(false);
    collapseTimerRef.current = window.setTimeout(() => setDockCollapsed(true), 6000);
  }

  useEffect(() => {
    if (!active || share.role !== "sharer") return;
    keepDockOpen();
    return () => window.clearTimeout(collapseTimerRef.current);
  }, [active, share.role]);

  async function generateCode() {
    setBusy(true);
    try {
      await share.generateShareCode();
    } finally {
      setBusy(false);
    }
  }

  async function joinCode() {
    setBusy(true);
    try {
      await share.joinWithCode(code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(share.requestPeer || share.inviteOnlyRequest) && (
        <div className="ss-modal-backdrop" role="dialog" aria-modal="true" aria-label="Start screen share">
          <section className="ss-modal">
            <header>
              <span><ScreenShare size={18} /><strong>Share Screen</strong></span>
              <button type="button" onClick={share.cancelRequest} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="ss-code-panel">
              <button type="button" className="ss-code-action" disabled={busy || !share.canShareScreen} onClick={() => void generateCode()}>
                <Monitor size={22} />
                <span>Generate Code</span>
                <small>{share.canShareScreen ? "Share your screen" : "Use Chrome desktop or Android app"}</small>
              </button>
              <form className="ss-code-entry" onSubmit={(event) => { event.preventDefault(); void joinCode(); }}>
                <label htmlFor="screen-share-code">Enter Code</label>
                <div>
                  <Hash size={18} />
                  <input
                    id="screen-share-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={code}
                    placeholder="12345678"
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                  />
                </div>
                <button type="submit" disabled={busy || code.length !== 8}><LogIn size={17} /> Join</button>
              </form>
            </div>
            {!share.canShareScreen && <p className="ss-support-note">This browser can join a share. To generate a code from mobile, open the AutoAI Android app.</p>}
            {share.error && <p className="ss-error">{share.error}</p>}
          </section>
        </div>
      )}

      {share.pendingInvite && (
        <div className="ss-invite" role="dialog" aria-label="Screen share invite">
          <span className="ss-avatar">{inviteAvatar ? <img src={inviteAvatar} alt="" /> : share.pendingInvite.sharer.display_name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{share.pendingInvite.message || `${share.pendingInvite.sharer.display_name} wants to share screen with you`}</strong>
            <small>@{share.pendingInvite.sharer.username}</small>
          </div>
          <button type="button" className="join" onClick={() => void share.joinInvite()}>Join</button>
          <button type="button" onClick={() => void share.declineInvite()}>Decline</button>
        </div>
      )}

      {active && share.role === "viewer" && (
        <ScreenShareViewer
          stream={share.remoteStream}
          paused={share.paused}
          status={share.uiState}
          error={share.error}
          onClose={() => void share.stopShare()}
          onToggleMic={() => void share.toggleMute()}
          micMuted={share.muted}
        />
      )}

      {active && share.role === "sharer" && (
        <div
          ref={dock.ref}
          className={`ss-control-bar ss-floating-dock ${dockCollapsed ? "ss-dock-collapsed" : "ss-dock-expanded"}`}
          style={dock.style}
          role="toolbar"
          aria-label="Screen sharing controls"
          tabIndex={0}
          onPointerDown={dock.onPointerDown}
          onPointerMove={dock.onPointerMove}
          onPointerUp={dock.onPointerUp}
          onPointerCancel={dock.onPointerCancel}
          onKeyDown={dock.onKeyDown}
          onPointerEnter={keepDockOpen}
          onFocus={keepDockOpen}
        >
          <AudioSurface stream={share.remoteStream} />
          <button type="button" className="ss-drag-handle" aria-label="Move screen share controls" title="Drag controls"><GripHorizontal size={17} /></button>
          <span className="ss-live-summary"><ScreenShare size={17} /><strong>Live</strong><time>{duration}</time></span>
          <button type="button" className="ss-dock-toggle" onClick={() => setDockCollapsed((value) => !value)} aria-label={dockCollapsed ? "Expand controls" : "Minimize controls"}>{dockCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button>
          <div className="ss-dock-expanded-content">
          {share.uiState === "reconnecting" && <small>Reconnecting...</small>}
          {share.uiState === "waiting" && <small>Waiting for viewer</small>}
          <small className={`ss-network ss-network-${share.networkQuality}`}>{share.networkQuality === "poor" ? "Poor network" : share.networkQuality === "good" ? "Network good" : share.networkQuality}</small>
          {share.sentResolution && <small>{share.sentResolution}</small>}
          <small className="ss-viewer-count"><Users size={13} />{share.session?.viewer_user_id || share.session?.viewerUserId ? 1 : 0}</small>
          <AppSelect value={share.qualityMode} onChange={(value) => share.setQualityMode(value as ScreenShareQualityMode)} label="Screen share quality" options={[{value:"auto",label:"Auto"},{value:"data-saver",label:"Data Saver"},{value:"sharp-text",label:"Sharp Text"},{value:"smooth-motion",label:"Smooth Motion"},{value:"hd",label:"HD"}]} />
          {share.shareCode && <div className="ss-code-chip-wrap"><button type="button" className="ss-code-pill" onClick={() => setCodeExpanded((value) => !value)} aria-expanded={codeExpanded} aria-label="Show screen share code"><Hash size={15} /><span>{codeExpanded ? share.shareCode : `${share.shareCode.slice(0, 3)}•••`}</span></button>{codeExpanded && <div className="ss-code-popover"><strong>{share.shareCode}</strong><button type="button" onClick={() => void share.copyShareCode()}><Clipboard size={14} /> Copy</button><button type="button" onClick={() => void share.copyInviteLink()}>Share link</button></div>}</div>}
          <button type="button" onClick={() => void share.toggleMute()} aria-label={share.muted ? "Turn on mic" : "Mute mic"}>{share.muted ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button type="button" onClick={share.togglePause} aria-label={share.paused ? "Resume share" : "Pause share"}>{share.paused ? <Play size={17} /> : <Pause size={17} />}</button>
          <button type="button" onClick={() => void (share.shareCode ? share.copyShareCode() : share.copyInviteLink())} aria-label={share.shareCode ? "Copy code" : "Copy invite link"}><Clipboard size={17} /></button>
          <button type="button" className="stop" onClick={() => void share.stopShare()}><Square size={16} /> Stop Sharing</button>
          </div>
        </div>
      )}

      {share.error && !share.requestPeer && !share.inviteOnlyRequest && !active && (
        <div className="ss-toast"><span>{share.error}</span><button type="button" onClick={share.clearError}><X size={14} /></button></div>
      )}
    </>
  );
}
