import { AlertTriangle, Camera, CameraOff, Copy, Mic, MicOff, Minimize2, Phone, PhoneOff, RefreshCw, Settings, SwitchCamera, Volume2, VolumeX, Wifi } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { useCallSession } from "./hooks/useCallSession";
import { callNative } from "./services/callNative";
import { CrystalAvatarRing } from "../../components/crystal/Crystal";
import type { CrystalCallState } from "../../crystal/tokens";
import { callStatusPresentation } from "./callStatus";
import { callFailurePresentation } from "./callFailures";

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

export function RemoteAudioSurface({ stream, callId, traceId, role, active }: { stream: MediaStream | null; callId?: string; traceId?: string; role?: string; active: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    const play = () => {
      if (!stream?.getAudioTracks().some((track) => track.readyState === "live")) return;
      void audio.play().then(
        () => console.debug("[AutoAI Call] REMOTE_AUDIO_PLAY_STARTED", { call_id: callId, trace_id: traceId, role }),
        () => console.warn("[AutoAI Call] REMOTE_AUDIO_PLAY_FAILED", { call_id: callId, trace_id: traceId, role, safe_error_code: "REMOTE_AUDIO_AUTOPLAY_BLOCKED" }),
      );
    };
    const onVisibility = () => { if (document.visibilityState === "visible") play(); };
    const tracks = stream?.getAudioTracks() ?? [];
    tracks.forEach((track) => track.addEventListener("unmute", play));
    stream?.addEventListener("addtrack", play);
    document.addEventListener("visibilitychange", onVisibility);
    if (active) play();
    return () => {
      tracks.forEach((track) => track.removeEventListener("unmute", play));
      stream?.removeEventListener("addtrack", play);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, callId, role, stream, traceId]);
  return <audio ref={ref} autoPlay playsInline muted={false} className="remote-call-audio" aria-label="Remote call audio" />;
}

function Avatar({ name, url, ringState }: { name: string; url?: string | null; ringState: CrystalCallState }) {
  const avatarUrl = resolveApiAssetUrl(url);
  return (
    <CrystalAvatarRing state={ringState}>
      <span className="call-screen-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : name.slice(0, 1).toUpperCase()}</span>
    </CrystalAvatarRing>
  );
}

export function CallOverlay() {
  const callSession = useCallSession();
  const { sessionState, signalingState, call, peer, localStream, remoteStream, cameraEnabled, remoteCameraEnabled, muted, speakerEnabled, networkQuality, error } = callSession;
  const [seconds, setSeconds] = useState(0);
  const [pipPosition, setPipPosition] = useState({ x: 0, y: 0 });
  const [incomingActionPending, setIncomingActionPending] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [minimized, setMinimized] = useState(false);
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
    setMinimized(false);
  }, [call?.id]);

  useEffect(() => {
    if (sessionState === "idle" || sessionState === "ended" || sessionState === "rejected" || sessionState === "cancelled" || sessionState === "missed" || sessionState === "busy" || sessionState === "failed") {
      setMinimized(false);
    }
  }, [sessionState]);

  useEffect(() => {
    const minimize = () => {
      if (sessionState !== "idle") setMinimized(true);
    };
    window.addEventListener("auto-ai-minimize-call-overlay", minimize);
    return () => window.removeEventListener("auto-ai-minimize-call-overlay", minimize);
  }, [sessionState]);

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
  const status = callStatusPresentation(sessionState);
  const failure = error ? callFailurePresentation(error, import.meta.env.DEV) : null;
  const activeLike = ["connecting", "active", "reconnecting", "ending"].includes(sessionState);
  const avatarUrl = resolveApiAssetUrl(peer.avatar_url);
  const hasRemoteVideo = Boolean(remoteStream?.getVideoTracks().some((track) => track.readyState === "live"));
  const avatarRingState: CrystalCallState = sessionState === "incoming" || sessionState === "ringing"
    ? "ringing"
    : sessionState === "reconnecting"
      ? "reconnecting"
      : sessionState === "active"
        ? networkQuality === "poor" ? "poor" : "connected"
        : sessionState === "ended" || sessionState === "failed" || sessionState === "rejected" || sessionState === "cancelled" || sessionState === "missed"
          ? "ended"
          : "calling";

  if (minimized) {
    return (
      <>
        <RemoteAudioSurface stream={remoteStream} callId={call?.id} traceId={call?.trace_id} role={call?.direction} active={sessionState === "active"} />
        <button type="button" className="ongoing-call-chip" onClick={() => setMinimized(false)} aria-label={`Return to call with ${peer.display_name}`}>
          <span>{call?.call_type === "video" ? <VideoSurface stream={remoteStream && remoteCameraEnabled && hasRemoteVideo ? remoteStream : localStream} muted className="ongoing-call-video" /> : <Phone size={16} />}</span>
          <strong>{peer.display_name}</strong>
          <small>{sessionState === "active" ? time : status.label}</small>
        </button>
      </>
    );
  }

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

  function runControl(action: () => void | Promise<void>) {
    if (controlPending) return;
    setControlPending(true);
    try {
      void Promise.resolve(action()).finally(() => window.setTimeout(() => setControlPending(false), 350));
    } catch {
      window.setTimeout(() => setControlPending(false), 350);
    }
  }

  function FailureNotice({ floating = false }: { floating?: boolean }) {
    if (!failure) return null;
    return (
      <div className={`call-screen-error${floating ? " floating" : ""}`} role="alert">
        <AlertTriangle size={18} aria-hidden="true" />
        <span><strong>{failure.title}</strong><small>{failure.message}</small></span>
        {failure.permissionRelated && callNative.isAndroid() && <button type="button" onClick={() => void callNative.openAppSettings()}><Settings size={14} /> Settings</button>}
        {failure.diagnostic && <button type="button" onClick={() => void navigator.clipboard?.writeText(failure.diagnostic || "")}><Copy size={14} /> Copy diagnostics</button>}
      </div>
    );
  }

  if (incoming) {
    return (
      <div className="incoming-call-screen neural-call-screen" data-call-semantic={status.semantic} role="dialog" aria-modal="true" aria-label={`Incoming call from ${peer.display_name}`}>
        {avatarUrl && <div className="incoming-call-backdrop" style={{ backgroundImage: `url(${avatarUrl})` }} />}
        <div className="call-orbit-bg" aria-hidden="true" />
        <div className="incoming-call-content">
          <div className="incoming-avatar-wrap"><Avatar name={peer.display_name} url={peer.avatar_url} ringState={avatarRingState} /></div>
          <p>Incoming Auto-AI {call?.call_type === "audio" ? "Audio" : "Video"} Call</p>
          <h2>{peer.display_name}</h2>
          <span>@{peer.username}</span>
          <small className="call-privacy-note">Your email and mobile number remain private.</small>
          <FailureNotice />
          <div className="incoming-call-actions">
            <button type="button" className="reject" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, callSession.rejectCall)} aria-label="Reject call"><PhoneOff size={23} /><span>Reject</span></button>
            {!failure && call?.call_type === "video" && <button type="button" className="audio-only" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, () => callSession.acceptCall(true))} aria-label="Accept as audio only"><Mic size={22} /><span>Audio only</span></button>}
            <button type="button" className="accept" disabled={incomingActionPending} onClick={(event) => runIncomingAction(event, () => callSession.acceptCall(false))} aria-label={failure ? "Retry accepting call" : "Accept call"}>{failure ? <RefreshCw size={23} /> : <Phone size={23} />}<span>{failure ? "Retry" : "Accept"}</span></button>
          </div>
        </div>
      </div>
    );
  }

  if (!activeLike) {
    return (
      <div className="outgoing-call-screen neural-call-screen" data-call-semantic={status.semantic} role="dialog" aria-modal="true" aria-label={`Calling ${peer.display_name}`}>
        <div className="call-orbit-bg" aria-hidden="true" />
        <div className="auto-ai-watermark" aria-hidden="true">Auto-AI</div>
        <section className="outgoing-profile-card">
          <div className="outgoing-avatar-orbit"><Avatar name={peer.display_name} url={peer.avatar_url} ringState={avatarRingState} /></div>
          <h2>{peer.display_name}</h2>
          <span>@{peer.username}</span>
          <p>{call?.call_type === "audio" ? "Audio Call" : "Video Call"}</p>
          <strong className="call-state-label">{status.label}</strong>
          <small className={`call-quality ${networkQuality}`}><Wifi size={14} /> {signalingState === "connected" ? (networkQuality === "unknown" ? "Signaling connected" : `${networkQuality} network`) : signalingState === "connecting" ? "Connecting signaling" : "Signaling unavailable"}</small>
        </section>
        {localStream && call?.call_type === "video" && <div className="outgoing-local-preview"><VideoSurface stream={localStream} muted className="local-call-video" /></div>}
        <FailureNotice floating />
        <button type="button" className="outgoing-cancel-call" disabled={controlPending} onClick={() => runControl(callSession.endCall)} aria-label="Cancel call"><PhoneOff size={22} /><span>Cancel Call</span></button>
      </div>
    );
  }

  return (
    <div className="active-call-screen neural-call-screen" data-call-semantic={status.semantic} role="dialog" aria-modal="true" aria-label={`Call with ${peer.display_name}`}>
      <RemoteAudioSurface stream={remoteStream} callId={call?.id} traceId={call?.trace_id} role={call?.direction} active={sessionState === "active"} />
      {remoteStream && remoteCameraEnabled && hasRemoteVideo ? <VideoSurface stream={remoteStream} muted className="remote-call-video" /> : <div className="remote-call-placeholder"><Avatar name={peer.display_name} url={peer.avatar_url} ringState={avatarRingState} /></div>}
      <div className="call-screen-shade" />
      <header className="active-call-header">
        <span><strong>{peer.display_name}</strong><small className="call-state-label">{sessionState === "active" ? time : status.label}</small></span>
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
      <FailureNotice floating />
      <nav className="active-call-controls" aria-label="Call controls">
        <button type="button" onClick={() => setMinimized(true)} aria-label="Minimize call"><Minimize2 size={21} /><span>Min</span></button>
        <button type="button" disabled={controlPending} className={muted ? "inactive" : ""} onClick={() => runControl(callSession.toggleMute)} aria-label={muted ? "Unmute microphone" : "Mute microphone"}>{muted ? <MicOff size={21} /> : <Mic size={21} />}<span>{muted ? "Unmute" : "Mute"}</span></button>
        {call?.call_type === "video" && <button type="button" disabled={controlPending} className={!cameraEnabled ? "inactive" : ""} onClick={() => runControl(callSession.toggleCamera)} aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"}>{cameraEnabled ? <Camera size={21} /> : <CameraOff size={21} />}<span>Camera</span></button>}
        {call?.call_type === "video" && <button type="button" disabled={controlPending || !cameraEnabled} onClick={() => runControl(callSession.switchCamera)} aria-label="Switch camera"><SwitchCamera size={21} /><span>Flip</span></button>}
        <button type="button" disabled={controlPending} className={!speakerEnabled ? "inactive" : ""} onClick={() => runControl(callSession.toggleSpeaker)} aria-label={speakerEnabled ? "Use earpiece" : "Use speaker"}>{speakerEnabled ? <Volume2 size={21} /> : <VolumeX size={21} />}<span>Audio</span></button>
        <button type="button" disabled={controlPending} className="hangup" onClick={() => runControl(callSession.endCall)} aria-label="End call"><PhoneOff size={23} /><span>End</span></button>
      </nav>
    </div>
  );
}
