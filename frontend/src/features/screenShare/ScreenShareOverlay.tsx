import { Clipboard, Monitor, MonitorPause, MonitorUp, Mic, MicOff, Pause, Play, ScreenShare, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { useScreenShare } from "./useScreenShare";
import type { ScreenShareSource } from "./types";

function VideoSurface({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} onLoadedMetadata={(event) => void event.currentTarget.play().catch(() => undefined)} />;
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

  async function start(source: ScreenShareSource) {
    await share.startShare(source);
  }

  return (
    <>
      {share.requestPeer && (
        <div className="ss-modal-backdrop" role="dialog" aria-modal="true" aria-label="Start screen share">
          <section className="ss-modal">
            <header>
              <span><ScreenShare size={18} /><strong>Share Screen</strong></span>
              <button type="button" onClick={share.cancelRequest} aria-label="Close"><X size={18} /></button>
            </header>
            <div className="ss-share-options">
              <button type="button" onClick={() => void start("screen")}><Monitor size={22} /><span>Share Entire Screen</span></button>
              <button type="button" onClick={() => void start("window")}><MonitorUp size={22} /><span>Window</span></button>
              <button type="button" onClick={() => void start("browser")}><ScreenShare size={22} /><span>Browser Tab</span></button>
            </div>
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
        <div className="ss-viewer" role="dialog" aria-modal="true" aria-label="Screen share viewer">
          {share.remoteStream ? <VideoSurface stream={share.remoteStream} className="ss-viewer-video" /> : <div className="ss-viewer-empty"><Monitor size={42} /><strong>{share.uiState === "reconnecting" ? "Reconnecting..." : "Waiting for screen..."}</strong></div>}
          <header className="ss-viewer-head">
            <strong>Screen Share</strong>
            <span>{share.uiState === "reconnecting" ? "Reconnecting" : share.uiState === "failed" ? "Failed" : "Live"}</span>
          </header>
          {share.paused && <div className="ss-paused"><MonitorPause size={18} /> Sharing paused</div>}
          {share.error && <div className="ss-floating-error">{share.error}</div>}
          <button type="button" className="ss-viewer-close" onClick={() => void share.stopShare()}><X size={18} /> Close</button>
        </div>
      )}

      {active && share.role === "sharer" && (
        <div className="ss-control-bar" role="status">
          <span><ScreenShare size={17} /><strong>You are sharing your screen</strong><time>{duration}</time></span>
          {share.uiState === "reconnecting" && <small>Reconnecting...</small>}
          {share.uiState === "waiting" && <small>Waiting for viewer</small>}
          <button type="button" onClick={share.toggleMute} aria-label={share.muted ? "Unmute mic" : "Mute mic"}>{share.muted ? <MicOff size={17} /> : <Mic size={17} />}</button>
          <button type="button" onClick={share.togglePause} aria-label={share.paused ? "Resume share" : "Pause share"}>{share.paused ? <Play size={17} /> : <Pause size={17} />}</button>
          <button type="button" onClick={() => void share.copyInviteLink()} aria-label="Copy invite link"><Clipboard size={17} /></button>
          <button type="button" className="stop" onClick={() => void share.stopShare()}><Square size={16} /> Stop Sharing</button>
        </div>
      )}

      {share.error && !share.requestPeer && !active && (
        <div className="ss-toast"><span>{share.error}</span><button type="button" onClick={share.clearError}><X size={14} /></button></div>
      )}
    </>
  );
}
