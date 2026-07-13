import { Camera, CameraOff, Mic, MicOff, Phone, PhoneOff, RefreshCw, Settings, SwitchCamera, Volume2, VolumeX, Wifi } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { useCallSession } from "./hooks/useCallSession";
import { callNative } from "./services/callNative";

function VideoSurface({ stream, muted, className }: { stream: MediaStream | null; muted?: boolean; className: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
  }, [stream]);
  return (
    <video
      ref={ref}
      className={className}
      autoPlay
      playsInline
      muted={muted}
      onLoadedMetadata={(event) => void event.currentTarget.play().catch(() => undefined)}
      onCanPlay={(event) => void event.currentTarget.play().catch(() => undefined)}
    />
  );
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  const avatarUrl = resolveApiAssetUrl(url);
  return <span className="call-screen-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : name.slice(0, 1).toUpperCase()}</span>;
}

function statusLabel(state: ReturnType<typeof useCallSession>["sessionState"]) {
  if (state === "preparing") return "Preparing...";
  if (state === "dialing") return "Calling...";
  if (state === "notifying") return "Notifying...";
  if (state === "ringing") return "Ringing...";
  if (state === "accepting") return "Accepting...";
  if (state === "connecting") return "Connecting...";
  if (state === "reconnecting") return "Reconnecting...";
  if (state === "rejected") return "Call rejected";
  if (state === "cancelled") return "Call cancelled";
  if (state === "missed") return "No answer";
  if (state === "busy") return "User is on another call";
  if (state === "failed") return "Call failed";
  if (state === "ended") return "Call ended";
  return "Connected";
}

export function CallOverlay() {
  const callSession = useCallSession();
  const { sessionState, call, peer, localStream, remoteStream, cameraEnabled, remoteCameraEnabled, muted, speakerEnabled, networkQuality, error } = callSession;
  const [seconds, setSeconds] = useState(0);
  const [pipPosition, setPipPosition] = useState({ x: 0, y: 0 });
  const [incomingActionPending, setIncomingActionPending] = useState(false);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    if (sessionState !== "active") { setSeconds(0); return; }
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [sessionState]);

  useEffect(() => {
    if (sessionState === "incoming") setIncomingActionPending(false);
  }, [call?.id, sessionState]);

  useEffect(() => {
    const active = sessionState !== "idle";
    document.documentElement.dataset.autoAiCallActive = active ? "true" : "false";
    return () => {
      document.documentElement.dataset.autoAiCallActive = "false";
    };
  }, [sessionState]);

  if (sessionState === "idle" || !peer) return null;

  const time = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  const incoming = sessionState === "incoming";
  const activeLike = ["connecting", "active", "reconnecting", "ending"].includes(sessionState);
  const avatarUrl = resolveApiAssetUrl(peer.avatar_url);
  const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().some((track) => track.readyState === "live"));

  function movePip(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const maxX = Math.max(0, window.innerWidth - 150);
    const maxY = Math.max(0, window.innerHeight - 230);
    setPipPosition({
      x: Math.max(-maxX, Math.min(maxX, dragRef.current.originX + event.clientX - dragRef.current.x)),
      y: Math.max(-maxY, Math.min(maxY, dragRef.current.originY + event.clientY - dragRef.current.y)),
    });
  }

  function runIncomingAction(event: ReactMouseEvent<HTMLButtonElement>, action: () => Promise<void>) {
    event.preventDefault();
    event.stopPropagation();
    if (incomingActionPending) return;
    setIncomingActionPending(true);
    void action().catch(() => setIncomingActionPending(false));
  }

  if (incoming) {
    return (
      <div className="incoming-call-screen neural-call-screen" role="dialog" aria-modal="true" aria-label={`Incoming call from ${peer.display_name}`}>
        {avatarUrl && <div className="incoming-call-backdrop" style={{ backgroundImage: `url(${avatarUrl})` }} />}
        <div className="call-orbit-bg" aria-hidden="true" />
        <div className="incoming-call-content">
          <div className="incoming-avatar-wrap"><span className="incoming-pulse" /><Avatar name={peer.display_name} url={peer.avatar_url} /></div>
          <p>Incoming Auto-AI {call?.call_type === "audio" ? "Audio" : "Video"} Call</p>
          <h2>{peer.display_name}</h2>
          <span>@{peer.username}</span>
          <small className="call-privacy-note">Your email and mobile number remain private.</small>
          {error && <div className="call-screen-error">{error}</div>}
          <div className="incoming-call-actions">
            <button type="button" className="reject" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, callSession.rejectCall)} aria-label="Reject call"><PhoneOff size={23} /><span>Reject</span></button>
            {call?.call_type === "video" && <button type="button" className="audio-only" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, () => callSession.acceptCall(true))} aria-label="Accept as audio only"><Mic size={22} /><span>Audio only</span></button>}
            <button type="button" className="accept" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, () => callSession.acceptCall(false))} aria-label="Accept call"><Phone size={23} /><span>Accept</span></button>
          </div>
        </div>
      </div>
    );
  }

  if (!activeLike) {
    return (
      <div className="outgoing-call-screen neural-call-screen" role="dialog" aria-modal="true" aria-label={`Calling ${peer.display_name}`}>
        <div className="call-orbit-bg" aria-hidden="true" />
        <div className="auto-ai-watermark" aria-hidden="true">Auto-AI</div>
        <section className="outgoing-profile-card">
          <div className="outgoing-avatar-orbit"><Avatar name={peer.display_name} url={peer.avatar_url} /></div>
          <h2>{peer.display_name}</h2>
          <span>@{peer.username}</span>
          <p>{call?.call_type === "audio" ? "Audio Call" : "Video Call"}</p>
          <strong>{statusLabel(sessionState)}</strong>
          <small className={`call-quality ${networkQuality}`}><Wifi size={14} /> {networkQuality === "unknown" ? "Network ready" : `${networkQuality} network`}</small>
        </section>
        {localStream && call?.call_type === "video" && <div className="outgoing-local-preview"><VideoSurface stream={localStream} muted className="local-call-video" /></div>}
        {error && <div className="call-screen-error floating"><span>{error}</span></div>}
        <button type="button" className="outgoing-cancel-call" onClick={() => void callSession.endCall()} aria-label="Cancel call"><PhoneOff size={22} /><span>Cancel Call</span></button>
      </div>
    );
  }

  return (
    <div className="active-call-screen neural-call-screen" role="dialog" aria-modal="true" aria-label={`Call with ${peer.display_name}`}>
      {remoteStream && remoteCameraEnabled && hasRemoteVideo ? <VideoSurface stream={remoteStream} className="remote-call-video" /> : <div className="remote-call-placeholder"><Avatar name={peer.display_name} url={peer.avatar_url} /></div>}
      <div className="call-screen-shade" />
      <header className="active-call-header">
        <span><strong>{peer.display_name}</strong><small>{sessionState === "active" ? time : statusLabel(sessionState)}</small></span>
        <span className={`call-quality ${networkQuality}`} title={`${networkQuality} network quality`}><Wifi size={16} /> {networkQuality === "unknown" ? "Connecting" : networkQuality}</span>
      </header>
      {localStream && cameraEnabled && (
        <div
          className="local-call-preview"
          style={{ transform: `translate(${pipPosition.x}px, ${pipPosition.y}px)` }}
          onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { x: event.clientX, y: event.clientY, originX: pipPosition.x, originY: pipPosition.y }; }}
          onPointerMove={movePip}
          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); dragRef.current = null; }}
          onPointerCancel={() => { dragRef.current = null; }}
        ><VideoSurface stream={localStream} muted className="local-call-video" /></div>
      )}
      {error && <div className="call-screen-error floating"><span>{error}</span>{callNative.isAndroid() && /permission/i.test(error) && <button type="button" onClick={() => void callNative.openAppSettings()}><Settings size={14} /> Settings</button>}</div>}
      <nav className="active-call-controls" aria-label="Call controls">
        <button type="button" className={muted ? "inactive" : ""} onClick={callSession.toggleMute} aria-label={muted ? "Unmute microphone" : "Mute microphone"}>{muted ? <MicOff size={21} /> : <Mic size={21} />}<span>{muted ? "Unmute" : "Mute"}</span></button>
        {call?.call_type === "video" && <button type="button" className={!cameraEnabled ? "inactive" : ""} onClick={() => void callSession.toggleCamera()} aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}>{cameraEnabled ? <Camera size={21} /> : <CameraOff size={21} />}<span>Camera</span></button>}
        {call?.call_type === "video" && <button type="button" disabled={!cameraEnabled} onClick={() => void callSession.switchCamera()} aria-label="Switch camera"><SwitchCamera size={21} /><span>Flip</span></button>}
        <button type="button" className={!speakerEnabled ? "inactive" : ""} onClick={() => void callSession.toggleSpeaker()} aria-label={speakerEnabled ? "Use earpiece" : "Use speaker"}>{speakerEnabled ? <Volume2 size={21} /> : <VolumeX size={21} />}<span>Audio</span></button>
        {sessionState === "failed" && <button type="button" onClick={() => void callSession.endCall()} aria-label="Close failed call"><RefreshCw size={21} /><span>Close</span></button>}
        <button type="button" className="hangup" onClick={() => void callSession.endCall()} aria-label="End call"><PhoneOff size={23} /><span>End</span></button>
      </nav>
    </div>
  );
}
