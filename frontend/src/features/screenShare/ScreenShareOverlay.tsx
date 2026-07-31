import { GripHorizontal, Hash, LogIn, Monitor, Pause, Play, ScreenShare, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { ScreenShareViewer } from "./ScreenShareViewer";
import { useScreenShare } from "./useScreenShare";
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

export function ScreenShareOverlay() {
  const share = useScreenShare();
  const inviteAvatar = resolveApiAssetUrl(share.pendingInvite?.sharer.avatar_url);
  const active = share.uiState !== "idle" && share.uiState !== "ended";
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const dock = useFloatingPanel({ storageKey: "autoai.screen-share.dock.anchor", defaultAnchor: "bottom-center", bottomInset: 18 });

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
          className="ss-control-bar ss-floating-dock ss-dock-compact"
          style={dock.style}
          role="toolbar"
          aria-label="Screen sharing controls"
          tabIndex={0}
          onPointerDown={dock.onPointerDown}
          onPointerMove={dock.onPointerMove}
          onPointerUp={dock.onPointerUp}
          onPointerCancel={dock.onPointerCancel}
          onKeyDown={dock.onKeyDown}
        >
          <AudioSurface stream={share.remoteStream} />
          <button type="button" className="ss-drag-handle" aria-label="Move screen share controls" title="Drag controls"><GripHorizontal size={17} /></button>
          <button type="button" className="ss-pause-control" onClick={share.togglePause} aria-label={share.paused ? "Resume screen sharing" : "Pause screen sharing"}>{share.paused ? <Play size={17} /> : <Pause size={17} />}<span>{share.paused ? "Resume" : "Pause"}</span></button>
          <button type="button" className="stop ss-stop-control" onClick={() => void share.stopShare()}><Square size={16} /><span>Stop</span></button>
        </div>
      )}

      {share.error && !share.requestPeer && !share.inviteOnlyRequest && !active && (
        <div className="ss-toast"><span>{share.error}</span><button type="button" onClick={share.clearError}><X size={14} /></button></div>
      )}
    </>
  );
}
