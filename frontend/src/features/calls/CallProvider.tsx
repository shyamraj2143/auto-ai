import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { CallContext, type CallContextValue } from "./CallContext";
import { callApi } from "./services/callApi";
import { callNative } from "./services/callNative";
import { CallSignaling } from "./services/callSignaling";
import { mediaResourceCoordinator } from "./services/mediaResourceCoordinator";
import { nextCallState } from "./state/callStateMachine";
import type { CallRecord, CallSessionState, CallSettings, CallType, IncomingCallPayload, PublicCallUser, SignalEnvelope } from "./types";

const TERMINAL_EVENT_STATES: Record<string, CallSessionState> = {
  "call.rejected": "rejected",
  "call.cancelled": "cancelled",
  "call.missed": "missed",
  "call.busy": "busy",
  "call.ended": "ended",
};
const CALL_RECONNECT_GRACE_MS = 15_000;
const CALL_RELAY_UNAVAILABLE_MESSAGE = "Calling network relay is temporarily unavailable.";
const TIMER_NAMES = ["ringing", "noAnswer", "notificationExpiry", "outgoingTimeout", "fcmTimeout", "pendingRetry", "reconnect", "terminal"] as const;
type CallTimerName = typeof TIMER_NAMES[number];

function callDebug(label: string, details: Record<string, unknown> = {}) {
  if (!import.meta.env.DEV && localStorage.getItem("auto-ai-call-debug") !== "true") return;
  console.debug(`[AutoAI Call] ${label}`, details);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^Request failed \(\d+\):\s*/, "") : fallback;
}

function normalizeIceServers(iceServers: RTCIceServer[] | undefined) {
  return (iceServers ?? []).filter((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const validUrls = urls.filter((url) => typeof url === "string" && /^(stun|turns?):/.test(url));
    if (!validUrls.length) return false;
    if (import.meta.env.PROD && validUrls.some((url) => /^turns?:([^@/]*@)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|[/?]|$)/i.test(url))) return false;
    const hasTurnUrl = validUrls.some((url) => /^turns?:/i.test(url));
    if (hasTurnUrl && (typeof server.username !== "string" || !server.username.trim() || typeof server.credential !== "string" || !server.credential)) return false;
    return true;
  });
}

function isRelayCandidate(candidate: RTCIceCandidate) {
  return /\styp relay(\s|$)/.test(candidate.candidate);
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const [config, setConfig] = useState<CallContextValue["config"]>(null);
  const [signalingState, setSignalingState] = useState<CallContextValue["signalingState"]>("disconnected");
  const [sessionState, setSessionState] = useState<CallSessionState>("idle");
  const [call, setCall] = useState<CallRecord | null>(null);
  const [pendingPeer, setPendingPeer] = useState<PublicCallUser | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [remoteCameraEnabled, setRemoteCameraEnabled] = useState(true);
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const [networkQuality, setNetworkQuality] = useState<CallContextValue["networkQuality"]>("unknown");
  const [error, setError] = useState("");
  const configRef = useRef(config);
  const callSettingsRef = useRef<CallSettings | null>(null);
  const sessionStateRef = useRef(sessionState);
  const callRef = useRef(call);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const peerCallIdRef = useRef<string | null>(null);
  const turnCredentialsRef = useRef<{ iceServers: RTCIceServer[]; relayConfigured: boolean; warning?: string | null; expiresAtMs: number } | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const settingRemoteAnswerRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const callTimersRef = useRef<Record<CallTimerName, number>>(Object.fromEntries(TIMER_NAMES.map((name) => [name, 0])) as Record<CallTimerName, number>);
  const statsTimerRef = useRef(0);
  const ringtoneTimerRef = useRef(0);
  const ringtoneContextRef = useRef<AudioContext | null>(null);
  const eventHandlerRef = useRef<(event: SignalEnvelope) => void>(() => undefined);
  const cleanupRef = useRef<(terminalState?: CallSessionState, detail?: string) => Promise<void>>(async () => undefined);
  const deviceIdRef = useRef<string | null>(null);
  const startPendingRef = useRef(false);
  const acceptInProgressRef = useRef(false);
  const rejectInProgressRef = useRef(false);
  const callEndedRef = useRef(false);
  const cleanupRunningRef = useRef(false);
  const intentionalPeerCloseRef = useRef(false);
  const acceptedCallIdsRef = useRef(new Set<string>());
  const connectedCallIdsRef = useRef(new Set<string>());
  const terminalCallIdsRef = useRef(new Set<string>());
  const nativeAcceptIdsRef = useRef(new Set<string>());
  const processedNativeActionIdsRef = useRef(new Set<string>());
  const acceptCallRef = useRef<(audioOnly?: boolean) => Promise<void>>(async () => undefined);
  const rejectCallRef = useRef<() => Promise<void>>(async () => undefined);
  const originalTitleRef = useRef(document.title);

  const localTrackStatus = useCallback(() => ({
    audio: localStreamRef.current?.getAudioTracks().map((track) => ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState })) ?? [],
    video: localStreamRef.current?.getVideoTracks().map((track) => ({ enabled: track.enabled, muted: track.muted, readyState: track.readyState })) ?? [],
  }), []);

  const clearCallTimer = useCallback((name: CallTimerName) => {
    window.clearTimeout(callTimersRef.current[name]);
    callTimersRef.current[name] = 0;
  }, []);

  const setCallTimer = useCallback((name: CallTimerName, handler: () => void, delayMs: number) => {
    clearCallTimer(name);
    callTimersRef.current[name] = window.setTimeout(() => {
      callTimersRef.current[name] = 0;
      callDebug("timer_fired", { call_id: callRef.current?.id, role: callRef.current?.direction, timer: name, state: sessionStateRef.current });
      handler();
    }, delayMs);
  }, [clearCallTimer]);

  const clearProgressTimers = useCallback(() => {
    (["ringing", "noAnswer", "notificationExpiry", "outgoingTimeout", "fcmTimeout", "pendingRetry", "reconnect"] as CallTimerName[]).forEach(clearCallTimer);
  }, [clearCallTimer]);

  const transition = useCallback((next: CallSessionState) => {
    setSessionState((current) => {
      const resolved = nextCallState(current, next);
      callDebug("state_transition", {
        call_id: callRef.current?.id,
        role: callRef.current?.direction,
        from: current,
        to: resolved,
        requested: next,
        signaling_connection_state: signalingState,
        local_tracks: localTrackStatus(),
      });
      return resolved;
    });
  }, [localTrackStatus, signalingState]);

  useEffect(() => { sessionStateRef.current = sessionState; }, [sessionState]);
  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);
  useEffect(() => { configRef.current = config; }, [config]);

  const signaling = useMemo(
    () => new CallSignaling((event) => eventHandlerRef.current(event), setSignalingState),
    [],
  );

  const refreshRealtime = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    const nextConfig = await callApi.config(token);
    setConfig(nextConfig);
    if (nextConfig.enabled && nextConfig.realtime_configured) {
      await signaling.retry(token);
    } else {
      signaling.close();
    }
    return nextConfig;
  }, [signaling, token]);

  const stopRingtone = useCallback(() => {
    window.clearInterval(ringtoneTimerRef.current);
    ringtoneTimerRef.current = 0;
    void ringtoneContextRef.current?.close().catch(() => undefined);
    ringtoneContextRef.current = null;
    navigator.vibrate?.(0);
    document.title = originalTitleRef.current;
  }, []);

  const clearRingTimer = useCallback(() => {
    clearCallTimer("ringing");
    clearCallTimer("noAnswer");
  }, [clearCallTimer]);

  const startRingtone = useCallback((silent: boolean) => {
    stopRingtone();
    document.title = "Incoming call - Auto-AI";
    if (silent) return;
    navigator.vibrate?.([500, 350, 500]);
    const beep = () => {
      try {
        const context = ringtoneContextRef.current ?? new AudioContext();
        ringtoneContextRef.current = context;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 720;
        gain.gain.value = 0.035;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.22);
      } catch {
        // Browser autoplay policies can prevent ringtone until the page is interacted with.
      }
    };
    beep();
    ringtoneTimerRef.current = window.setInterval(beep, 1700);
  }, [stopRingtone]);

  const requestLocalMedia = useCallback(async (callType: CallType, audioOnly = false) => {
    await mediaResourceCoordinator.acquire("person-call");
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const dataSaving = Boolean(callSettingsRef.current?.data_saving_mode);
    const video: MediaTrackConstraints | false = callType === "video" && !audioOnly
      ? { width: { ideal: dataSaving ? 640 : 1280, max: dataSaving ? 640 : 1280 }, height: { ideal: dataSaving ? 360 : 720, max: dataSaving ? 360 : 720 }, frameRate: { ideal: dataSaving ? 18 : 24, max: dataSaving ? 20 : 30 }, facingMode: "user" }
      : false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMuted(false);
      setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled));
      return stream;
    } catch (mediaError) {
      if (video) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
          localStreamRef.current = stream;
          setLocalStream(stream);
          setCameraEnabled(false);
          setError("Camera permission was not granted. Continuing with audio only.");
          callDebug("camera_unavailable_audio_fallback", { call_id: callRef.current?.id, role: callRef.current?.direction });
          return stream;
        } catch {
          mediaResourceCoordinator.release("person-call");
        }
      } else {
        mediaResourceCoordinator.release("person-call");
      }
      throw mediaError;
    }
  }, []);

  const collectStats = useCallback(async () => {
    const peer = peerConnectionRef.current;
    if (!peer || peer.connectionState !== "connected") return;
    const reports = await peer.getStats().catch(() => null);
    if (!reports) return;
    let loss = 0;
    let received = 0;
    let rtt = 0;
    let selectedLocalCandidateId = "";
    let selectedRemoteCandidateId = "";
    reports.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        loss += Number(report.packetsLost || 0);
        received += Number(report.packetsReceived || 0);
      }
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || !selectedLocalCandidateId)) {
        rtt = Number(report.currentRoundTripTime || 0);
        selectedLocalCandidateId = String(report.localCandidateId || "");
        selectedRemoteCandidateId = String(report.remoteCandidateId || "");
      }
    });
    const localCandidate = selectedLocalCandidateId ? reports.get(selectedLocalCandidateId) : null;
    const remoteCandidate = selectedRemoteCandidateId ? reports.get(selectedRemoteCandidateId) : null;
    if (localCandidate || remoteCandidate) {
      callDebug("selected_candidate_pair", {
        call_id: callRef.current?.id,
        local_type: localCandidate?.candidateType,
        remote_type: remoteCandidate?.candidateType,
      });
    }
    const lossRate = received + loss > 0 ? loss / (received + loss) : 0;
    const quality = lossRate > 0.08 || rtt > 0.55 ? "poor" : lossRate > 0.03 || rtt > 0.28 ? "fair" : "good";
    setNetworkQuality(quality);
    const maxBitrate = quality === "poor" ? 300_000 : quality === "fair" ? 650_000 : 1_200_000;
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = maxBitrate;
      await sender.setParameters(parameters).catch(() => undefined);
      await sender.track?.applyConstraints(
        quality === "poor" ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 18 } } : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } }
      ).catch(() => undefined);
    }
  }, []);

  const beginStats = useCallback(() => {
    window.clearInterval(statsTimerRef.current);
    statsTimerRef.current = window.setInterval(() => void collectStats(), 3000);
  }, [collectStats]);

  const loadIceConfiguration = useCallback(async () => {
    const cached = turnCredentialsRef.current;
    if (cached && cached.expiresAtMs - Date.now() > 60_000) return cached;
    try {
      const credentials = await callApi.turnCredentials(token || "");
      const returnedServers = normalizeIceServers(credentials.iceServers ?? credentials.ice_servers);
      const expiresValue = credentials.expiresAt ?? credentials.expires_at;
      const expiresAtMs = expiresValue ? Date.parse(expiresValue) : Date.now() + 5 * 60_000;
      const relayConfigured = Boolean(credentials.configured ?? credentials.relayConfigured ?? credentials.relay_configured);
      if (!returnedServers.length || !relayConfigured) throw new Error(CALL_RELAY_UNAVAILABLE_MESSAGE);
      if (!relayConfigured && configRef.current?.diagnostic === CALL_RELAY_UNAVAILABLE_MESSAGE) {
        throw new Error(CALL_RELAY_UNAVAILABLE_MESSAGE);
      }
      const next = {
        iceServers: returnedServers,
        relayConfigured,
        warning: credentials.warning,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 5 * 60_000,
      };
      turnCredentialsRef.current = next;
      if (credentials.warning) setError(CALL_RELAY_UNAVAILABLE_MESSAGE);
      callDebug("turn_credentials_loaded", { provider: credentials.provider, relay_configured: relayConfigured, ice_servers: returnedServers.length, credential_endpoint: "ok" });
      return next;
    } catch (turnError) {
      turnCredentialsRef.current = null;
      callDebug("turn_credentials_failed", { credential_endpoint: "failed" });
      const message = errorMessage(turnError, CALL_RELAY_UNAVAILABLE_MESSAGE);
      throw new Error(/turn|relay|503|not configured/i.test(message) ? CALL_RELAY_UNAVAILABLE_MESSAGE : message);
    }
  }, [token]);

  const attemptReconnect = useCallback(async () => {
    const peer = peerConnectionRef.current;
    const currentCall = callRef.current;
    if (!peer || !currentCall) return;
    if (reconnectAttemptsRef.current >= 3) {
      await cleanupRef.current("failed", "The call could not reconnect.");
      return;
    }
    reconnectAttemptsRef.current += 1;
    transition("reconnecting");
    callDebug("ice_restart_attempt", { call_id: currentCall.id, attempt: reconnectAttemptsRef.current, state: peer.connectionState });
    try {
      peer.restartIce();
      makingOfferRef.current = true;
      await peer.setLocalDescription(await peer.createOffer({ iceRestart: true }));
      signaling.send("webrtc.offer", currentCall.id, { ...(peer.localDescription?.toJSON() ?? {}) });
      callDebug("offer_sent", { call_id: currentCall.id, role: currentCall.direction, ice_restart: true });
    } catch {
      setCallTimer("pendingRetry", () => void attemptReconnect(), 2500 * reconnectAttemptsRef.current);
    } finally {
      makingOfferRef.current = false;
    }
  }, [setCallTimer, signaling, transition]);

  const ensurePeerConnection = useCallback(async (currentCall: CallRecord) => {
    if (peerConnectionRef.current && peerCallIdRef.current === currentCall.id) return peerConnectionRef.current;
    intentionalPeerCloseRef.current = true;
    peerConnectionRef.current?.close();
    intentionalPeerCloseRef.current = false;
    const iceConfig = await loadIceConfiguration();
    const verifyRelay = import.meta.env.DEV && localStorage.getItem("auto-ai-force-relay") === "true";
    if (verifyRelay) localStorage.removeItem("auto-ai-force-relay");
    let relayCandidateGathered = false;
    const peer = new RTCPeerConnection({
      iceServers: iceConfig.iceServers,
      iceTransportPolicy: verifyRelay ? "relay" : "all",
      bundlePolicy: "max-bundle",
    });
    callDebug("peer_connection_created", {
      call_id: currentCall.id,
      role: currentCall.direction,
      relay_configured: iceConfig.relayConfigured,
      ice_transport_policy: verifyRelay ? "relay" : "all",
      relay_verification: verifyRelay,
    });
    peerConnectionRef.current = peer;
    peerCallIdRef.current = currentCall.id;
    pendingIceRef.current = [];
    terminalCallIdsRef.current.delete(currentCall.id);
    localStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current!));
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream(remoteStreamRef.current?.getTracks() ?? []);
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      const nextRemoteStream = new MediaStream(stream.getTracks());
      remoteStreamRef.current = nextRemoteStream;
      setRemoteStream(nextRemoteStream);
      if (event.track.kind === "video") {
        setRemoteCameraEnabled(true);
        event.track.onmute = () => callDebug("remote_video_track_muted", { call_id: currentCall.id, role: currentCall.direction });
        event.track.onunmute = () => setRemoteCameraEnabled(true);
        event.track.onended = () => setRemoteCameraEnabled(false);
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        if (verifyRelay && isRelayCandidate(event.candidate)) {
          relayCandidateGathered = true;
          callDebug("relay_candidate_verified", { call_id: currentCall.id, role: currentCall.direction });
        }
        signaling.send("webrtc.ice_candidate", currentCall.id, { ...event.candidate.toJSON() });
        callDebug("ice_candidate_sent", { call_id: currentCall.id, role: currentCall.direction });
      }
    };
    peer.onnegotiationneeded = async () => {
      if (currentCall.direction === "incoming" && !peer.remoteDescription) {
        callDebug("receiver_waiting_for_offer", { call_id: currentCall.id, role: currentCall.direction });
        return;
      }
      try {
        makingOfferRef.current = true;
        await peer.setLocalDescription();
        if (peer.localDescription) signaling.send(`webrtc.${peer.localDescription.type}`, currentCall.id, { ...peer.localDescription.toJSON() });
        if (peer.localDescription) callDebug(`${peer.localDescription.type}_sent`, { call_id: currentCall.id, role: currentCall.direction });
      } catch (offerError) {
        setError(errorMessage(offerError, "Unable to negotiate the call."));
      } finally {
        makingOfferRef.current = false;
      }
    };
    peer.onconnectionstatechange = () => {
      callDebug("peer_connection_state", { call_id: currentCall.id, role: currentCall.direction, state: peer.connectionState });
      if (peer.connectionState !== "disconnected") clearCallTimer("reconnect");
      if (peer.connectionState === "connected") {
        reconnectAttemptsRef.current = 0;
        clearProgressTimers();
        transition("active");
        if (!connectedCallIdsRef.current.has(currentCall.id)) {
          connectedCallIdsRef.current.add(currentCall.id);
          signaling.send("call.connected", currentCall.id);
          beginStats();
          void callNative.startActiveCall({ callId: currentCall.id, displayName: currentCall.peer.display_name, startedAt: Date.now(), video: currentCall.call_type === "video" });
        }
      } else if (peer.connectionState === "disconnected") {
        transition("reconnecting");
        setCallTimer("reconnect", () => void attemptReconnect(), Math.max(CALL_RECONNECT_GRACE_MS, (configRef.current?.reconnect_grace_seconds ?? 15) * 1000));
      } else if (peer.connectionState === "failed") {
        void attemptReconnect();
      } else if (peer.connectionState === "closed" && !intentionalPeerCloseRef.current && !cleanupRunningRef.current && !["ending", "ended", "idle"].includes(sessionStateRef.current)) {
        callDebug("peer_connection_closed_ignored", { call_id: currentCall.id, role: currentCall.direction, state: sessionStateRef.current });
        transition("reconnecting");
      }
    };
    peer.oniceconnectionstatechange = () => {
      callDebug("ice_connection_state", { call_id: currentCall.id, role: currentCall.direction, state: peer.iceConnectionState });
      if (peer.iceConnectionState === "checking") {
        transition("connecting");
      } else if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        reconnectAttemptsRef.current = 0;
        clearProgressTimers();
        transition("active");
        if (!connectedCallIdsRef.current.has(currentCall.id)) {
          connectedCallIdsRef.current.add(currentCall.id);
          signaling.send("call.connected", currentCall.id);
          beginStats();
          void callNative.startActiveCall({ callId: currentCall.id, displayName: currentCall.peer.display_name, startedAt: Date.now(), video: currentCall.call_type === "video" });
        }
      } else if (peer.iceConnectionState === "disconnected") {
        transition("reconnecting");
        setCallTimer("reconnect", () => void attemptReconnect(), Math.max(CALL_RECONNECT_GRACE_MS, (configRef.current?.reconnect_grace_seconds ?? 15) * 1000));
      } else if (peer.iceConnectionState === "failed") {
        void attemptReconnect();
      }
    };
    peer.onicegatheringstatechange = () => {
      callDebug("ice_gathering_state", { call_id: currentCall.id, role: currentCall.direction, state: peer.iceGatheringState });
      if (verifyRelay && peer.iceGatheringState === "complete" && !relayCandidateGathered) {
        setError(CALL_RELAY_UNAVAILABLE_MESSAGE);
        callDebug("relay_candidate_missing", { call_id: currentCall.id, role: currentCall.direction });
      }
    };
    peer.onicecandidateerror = (event) => {
      callDebug("ice_candidate_error", { call_id: currentCall.id, role: currentCall.direction, error_code: event.errorCode });
    };
    return peer;
  }, [attemptReconnect, beginStats, clearCallTimer, clearProgressTimers, loadIceConfiguration, setCallTimer, signaling, transition]);

  const applyDescription = useCallback(async (event: SignalEnvelope) => {
    const currentCall = callRef.current;
    if (!currentCall || event.call_id !== currentCall.id) return;
    const peer = await ensurePeerConnection(currentCall);
    const description = event.payload as unknown as RTCSessionDescriptionInit;
    const polite = Boolean(user && user.id.localeCompare(currentCall.peer.id) > 0);
    const readyForOffer = !makingOfferRef.current && (peer.signalingState === "stable" || settingRemoteAnswerRef.current);
    const offerCollision = description.type === "offer" && !readyForOffer;
    ignoreOfferRef.current = !polite && offerCollision;
    if (ignoreOfferRef.current) return;
    settingRemoteAnswerRef.current = description.type === "answer";
    try {
      callDebug(`${description.type}_received`, { call_id: currentCall.id, role: currentCall.direction });
      await peer.setRemoteDescription(description);
      callDebug("remote_description_set", { call_id: currentCall.id, role: currentCall.direction, type: description.type });
      settingRemoteAnswerRef.current = false;
      const queued = pendingIceRef.current.splice(0);
      for (const candidate of queued) await peer.addIceCandidate(candidate).catch(() => undefined);
      if (queued.length) callDebug("queued_ice_applied", { call_id: currentCall.id, count: queued.length });
      if (description.type === "offer") {
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.localDescription) signaling.send("webrtc.answer", currentCall.id, { ...peer.localDescription.toJSON() });
        callDebug("answer_sent", { call_id: currentCall.id, role: currentCall.direction });
      }
    } catch (descriptionError) {
      settingRemoteAnswerRef.current = false;
      setError(errorMessage(descriptionError, "WebRTC negotiation failed."));
    }
  }, [ensurePeerConnection, signaling, user]);

  const applyIceCandidate = useCallback(async (event: SignalEnvelope) => {
    if (ignoreOfferRef.current || event.call_id !== callRef.current?.id) return;
    const candidate = event.payload as RTCIceCandidateInit;
    const peer = peerConnectionRef.current;
    callDebug("ice_candidate_received", { call_id: event.call_id, has_remote_description: Boolean(peer?.remoteDescription) });
    if (!peer?.remoteDescription) pendingIceRef.current.push(candidate);
    else await peer.addIceCandidate(candidate).catch(() => undefined);
  }, []);

  const cleanup = useCallback(async (terminalState: CallSessionState = "ended", detail = "") => {
    if (sessionStateRef.current === "idle" && !callRef.current && !localStreamRef.current) return;
    if (cleanupRunningRef.current) return;
    cleanupRunningRef.current = true;
    callEndedRef.current = true;
    callDebug("cleanup", { call_id: callRef.current?.id, state: sessionStateRef.current, terminal_state: terminalState, reason: detail });
    stopRingtone();
    clearProgressTimers();
    window.clearInterval(statsTimerRef.current);
    setSessionState(terminalState);
    sessionStateRef.current = terminalState;
    intentionalPeerCloseRef.current = true;
    peerConnectionRef.current?.getSenders().forEach((sender) => { sender.track?.stop(); });
    peerConnectionRef.current?.close();
    intentionalPeerCloseRef.current = false;
    peerConnectionRef.current = null;
    peerCallIdRef.current = null;
    pendingIceRef.current = [];
    if (callRef.current?.id) terminalCallIdsRef.current.add(callRef.current.id);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    remoteStreamRef.current = null;
    setCameraEnabled(false);
    setRemoteCameraEnabled(true);
    setMuted(false);
    setNetworkQuality("unknown");
    reconnectAttemptsRef.current = 0;
    mediaResourceCoordinator.release("person-call");
    await callNative.stopActiveCall(callRef.current?.id).catch(() => undefined);
    if (detail) setError(detail);
    setCallTimer("terminal", () => {
      setSessionState("idle");
      sessionStateRef.current = "idle";
      setCall(null);
      callRef.current = null;
      setPendingPeer(null);
      cleanupRunningRef.current = false;
      callEndedRef.current = false;
      rejectInProgressRef.current = false;
      acceptInProgressRef.current = false;
    }, terminalState === "ended" ? 900 : 2200);
  }, [clearProgressTimers, setCallTimer, stopRingtone]);
  cleanupRef.current = cleanup;

  const receiveIncomingCall = useCallback(async (callId: string, payload?: IncomingCallPayload) => {
    if (!token) return;
    if (sessionStateRef.current !== "idle") {
      if (callRef.current?.id === callId && sessionStateRef.current === "incoming") return;
      return;
    }
    try {
      const incomingCall = await callApi.get(token, callId);
      if (!["initiated", "ringing"].includes(incomingCall.status)) return;
      callEndedRef.current = false;
      rejectInProgressRef.current = false;
      acceptInProgressRef.current = false;
      callRef.current = incomingCall;
      setCall(incomingCall);
      setPendingPeer(incomingCall.peer);
      setSessionState("incoming");
      sessionStateRef.current = "incoming";
      signaling.send("call.ringing", callId);
      callDebug("incoming", { call_id: callId, role: "incoming", signaling_connected: signaling.isConnected() });
      const silent = Boolean(payload?.silent ?? incomingCall.silent);
      startRingtone(silent);
      if (document.visibilityState === "hidden" && "Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(`Incoming ${incomingCall.call_type} call`, { body: incomingCall.peer.display_name, icon: resolveApiAssetUrl(incomingCall.peer.avatar_url) || "/icons/icon-192.png", tag: `call-${callId}`, requireInteraction: true });
        notification.onclick = () => { window.focus(); notification.close(); };
      }
      clearRingTimer();
      setCallTimer("ringing", () => {
        if (["incoming"].includes(sessionStateRef.current)) void cleanup("missed", "Missed call");
      }, (configRef.current?.ring_timeout_seconds ?? 30) * 1000);
    } catch {
      // Expired or cancelled native notifications are dismissed without showing a stale call.
    }
  }, [cleanup, clearRingTimer, setCallTimer, signaling, startRingtone, token]);

  const processNativeCallAction = useCallback(async (callId: string, action?: NativeIncomingAction | null) => {
    const normalizedAction = action === "accept" || action === "reject" || action === "audio_only" ? action : null;
    if (!normalizedAction) {
      await receiveIncomingCall(callId);
      return;
    }
    const actionKey = `${callId}:${normalizedAction}`;
    if (processedNativeActionIdsRef.current.has(actionKey)) return;
    processedNativeActionIdsRef.current.add(actionKey);
    await receiveIncomingCall(callId);
    if (normalizedAction === "accept") {
      if (nativeAcceptIdsRef.current.has(callId)) return;
      nativeAcceptIdsRef.current.add(callId);
      await acceptCallRef.current(false);
    } else if (normalizedAction === "audio_only") {
      if (nativeAcceptIdsRef.current.has(callId)) return;
      nativeAcceptIdsRef.current.add(callId);
      await acceptCallRef.current(true);
    } else {
      await rejectCallRef.current();
    }
  }, [receiveIncomingCall]);

  const handleSignalEvent = useCallback((event: SignalEnvelope) => {
    if (event.type === "presence.user_updated" || event.type === "presence.snapshot") {
      window.dispatchEvent(new CustomEvent("auto-ai-presence-updated", { detail: event.payload }));
    }
    if (event.type === "call.incoming" && event.call_id) {
      void receiveIncomingCall(event.call_id, event.payload as unknown as IncomingCallPayload);
      return;
    }
    if (!event.call_id || event.call_id !== callRef.current?.id) return;
    if (event.type === "call.ringing") transition("ringing");
    else if (event.type === "call.accepted") {
      stopRingtone();
      clearProgressTimers();
      transition("connecting");
      callDebug("accepted_received", { call_id: event.call_id, state: sessionStateRef.current, role: callRef.current?.direction });
      if (callRef.current) {
        callRef.current = { ...callRef.current, status: "accepted" };
        setCall(callRef.current);
        void ensurePeerConnection(callRef.current);
      }
    } else if (event.type === "webrtc.offer" || event.type === "webrtc.answer") void applyDescription(event);
    else if (event.type === "webrtc.ice_candidate") void applyIceCandidate(event);
    else if (event.type === "webrtc.restart_required") void attemptReconnect();
    else if (event.type === "call.active") transition("active");
    else if (event.type === "call.media_state") setRemoteCameraEnabled(event.payload.camera_enabled !== false);
    else if (TERMINAL_EVENT_STATES[event.type]) {
      if (terminalCallIdsRef.current.has(event.call_id)) return;
      const currentStatus = callRef.current?.status;
      if ((event.type === "call.missed" || event.type === "call.cancelled") && currentStatus && ["accepted", "connecting", "active"].includes(currentStatus)) {
        callDebug("stale_terminal_ignored", { call_id: event.call_id, role: callRef.current?.direction, event_type: event.type, current_status: currentStatus });
        return;
      }
      terminalCallIdsRef.current.add(event.call_id);
      void cleanup(TERMINAL_EVENT_STATES[event.type], String(event.payload.end_reason || ""));
    }
    else if (event.type === "call.error") setError(String(event.payload.detail || "Call error"));
  }, [applyDescription, applyIceCandidate, attemptReconnect, cleanup, clearProgressTimers, ensurePeerConnection, receiveIncomingCall, stopRingtone, transition]);
  eventHandlerRef.current = handleSignalEvent;

  useEffect(() => {
    if (!token || !user) return;
    let active = true;
    void Promise.all([callApi.config(token), callApi.settings(token), callNative.registration()]).then(async ([nextConfig, callSettings, registration]) => {
      if (!active) return;
      setConfig(nextConfig);
      callSettingsRef.current = callSettings;
      if (!nextConfig.enabled || !nextConfig.realtime_configured) {
        signaling.close();
        return;
      }
      deviceIdRef.current = registration.device_id;
      await callApi.registerDevice(token, registration).catch(() => undefined);
      await signaling.connect(token);
      const nativeCall: { callId?: string | null; action?: NativeIncomingAction | null } = await callNative.consumeIncomingCall().catch(() => ({}));
      if (nativeCall.callId) await processNativeCallAction(nativeCall.callId, nativeCall.action);
    }).catch((configError) => {
      if (active) setError(errorMessage(configError, "Calling setup is unavailable."));
    });
    const visibility = () => signaling.updatePresence(document.visibilityState === "hidden" ? "background" : "online");
    const nativeIncoming = (event: Event) => {
      const rawDetail = event instanceof CustomEvent ? event.detail : null;
      let detail: NativeIncomingCallEvent | null = null;
      try {
        detail = typeof rawDetail === "string" ? JSON.parse(rawDetail) as NativeIncomingCallEvent : rawDetail as NativeIncomingCallEvent | null;
      } catch {
        detail = null;
      }
      if (!detail?.callId) return;
      void (async () => {
        await processNativeCallAction(detail.callId!, detail.action);
      })();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("auto-ai-incoming-call", nativeIncoming);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("auto-ai-incoming-call", nativeIncoming);
      signaling.close();
      callDebug("provider_unmount_preserve_call", {
        call_id: callRef.current?.id,
        state: sessionStateRef.current,
      });
    };
  }, [cleanup, processNativeCallAction, receiveIncomingCall, signaling, token, user]);

  useEffect(() => {
    const unload = () => {
      if (callRef.current && !["idle", "ended"].includes(sessionStateRef.current)) {
        callDebug("beforeunload_preserve_call", {
          call_id: callRef.current.id,
          role: callRef.current.direction,
          state: sessionStateRef.current,
        });
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);

  const startCall = useCallback(async (peer: PublicCallUser, callType: CallType = "video") => {
    if (!token || startPendingRef.current || sessionStateRef.current !== "idle") return;
    if (callType === "video" && !peer.can_video_call) { setError("This user is not accepting video calls."); return; }
    if (callType === "audio" && !peer.can_audio_call) { setError("This user is not accepting audio calls."); return; }
    if (configRef.current?.diagnostic === CALL_RELAY_UNAVAILABLE_MESSAGE) {
      setError(CALL_RELAY_UNAVAILABLE_MESSAGE);
      return;
    }
    startPendingRef.current = true;
    callEndedRef.current = false;
    rejectInProgressRef.current = false;
    acceptInProgressRef.current = false;
    setError("");
    setPendingPeer(peer);
    setSessionState("preparing");
    sessionStateRef.current = "preparing";
    try {
      await requestLocalMedia(callType);
      const created = await callApi.initiate(token, peer.id, callType, deviceIdRef.current);
      callRef.current = created;
      setCall(created);
      setSessionState("notifying");
      sessionStateRef.current = "notifying";
      void callNative.startActiveCall({
        callId: created.id,
        displayName: created.peer.display_name,
        startedAt: Date.now(),
        video: created.call_type === "video",
      }).catch((nativeError) => {
        callDebug("native_outgoing_service_failed", {
          call_id: created.id,
          reason: errorMessage(nativeError, "native start failed"),
        });
      });
      if (created.delivery === "unreachable") {
        callDebug("call_cancel_source", { call_id: created.id, role: created.direction, source: "delivery_unreachable" });
        await callApi.cancel(token, created.id).catch(() => undefined);
        await cleanup("failed", "User is unavailable");
        return;
      }
      clearCallTimer("noAnswer");
      setCallTimer("noAnswer", async () => {
        if (callRef.current?.id === created.id && ["dialing", "notifying", "ringing"].includes(sessionStateRef.current)) {
          callDebug("call_cancel_source", { call_id: created.id, role: created.direction, source: "noAnswerTimer", end_reason: "no_answer" });
          await callApi.cancel(token, created.id).catch(() => undefined);
          await cleanup("missed", "No answer");
        }
      }, (configRef.current?.ring_timeout_seconds ?? 30) * 1000);
    } catch (startError) {
      await cleanup("failed", errorMessage(startError, "Unable to start the call."));
    } finally {
      startPendingRef.current = false;
    }
  }, [cleanup, clearCallTimer, requestLocalMedia, setCallTimer, token]);

  const acceptCall = useCallback(async (audioOnly = false) => {
    const currentCall = callRef.current;
    if (!token || !currentCall || sessionStateRef.current !== "incoming" || startPendingRef.current || acceptInProgressRef.current || rejectInProgressRef.current || callEndedRef.current) return;
    startPendingRef.current = true;
    acceptInProgressRef.current = true;
    stopRingtone();
    clearProgressTimers();
    setSessionState("accepting");
    sessionStateRef.current = "accepting";
    let acceptedSent = false;
    try {
      const fresh = await callApi.get(token, currentCall.id);
      if (!["initiated", "ringing"].includes(fresh.status)) throw new Error("This call is no longer available.");
      if (configRef.current?.diagnostic === CALL_RELAY_UNAVAILABLE_MESSAGE) throw new Error(CALL_RELAY_UNAVAILABLE_MESSAGE);
      callDebug("accepting", { call_id: fresh.id, role: "incoming", state: fresh.status, signaling_connected: signaling.isConnected() });
      await signaling.connect(token);
      if (!await signaling.waitUntilConnected()) throw new Error("Call signaling is not connected.");
      await requestLocalMedia(fresh.call_type, audioOnly);
      callDebug("local_media_ready", {
        call_id: fresh.id,
        audio_tracks: localStreamRef.current?.getAudioTracks().length ?? 0,
        video_tracks: localStreamRef.current?.getVideoTracks().length ?? 0,
      });
      await loadIceConfiguration();
      if (acceptedCallIdsRef.current.has(fresh.id)) return;
      acceptedCallIdsRef.current.add(fresh.id);
      const accepted = await callApi.accept(token, fresh.id, deviceIdRef.current);
      acceptedSent = true;
      clearProgressTimers();
      callRef.current = accepted;
      setCall(accepted);
      setSessionState("connecting");
      sessionStateRef.current = "connecting";
      callDebug("accepted_sent", { call_id: accepted.id, role: "incoming", signaling_connected: signaling.isConnected() });
      await ensurePeerConnection(accepted);
    } catch (acceptError) {
      acceptedCallIdsRef.current.delete(currentCall.id);
      if (acceptedSent) {
        callDebug("call_end_source", { call_id: currentCall.id, role: currentCall.direction, source: "accept_post_accept_failure", end_reason: "network_failed" });
        await callApi.end(token, currentCall.id, "network_failed").catch(() => undefined);
      } else {
        callDebug("accept_setup_failed_no_reject", { call_id: currentCall.id, role: currentCall.direction, state: sessionStateRef.current });
      }
      await cleanup("failed", errorMessage(acceptError, "Unable to accept the call."));
    } finally {
      startPendingRef.current = false;
      acceptInProgressRef.current = false;
    }
  }, [cleanup, clearProgressTimers, ensurePeerConnection, loadIceConfiguration, requestLocalMedia, signaling, stopRingtone, token]);
  acceptCallRef.current = acceptCall;

  const rejectCall = useCallback(async () => {
    const currentCall = callRef.current;
    if (!token || !currentCall || rejectInProgressRef.current || acceptInProgressRef.current || cleanupRunningRef.current || callEndedRef.current) return;
    if (!["incoming"].includes(sessionStateRef.current) && !["initiated", "ringing"].includes(currentCall.status)) return;
    rejectInProgressRef.current = true;
    callEndedRef.current = true;
    try {
      stopRingtone();
      clearProgressTimers();
      callDebug("call_reject_source", { call_id: currentCall.id, role: currentCall.direction, state: sessionStateRef.current, source: "user_or_native_reject" });
      await callApi.reject(token, currentCall.id).catch(() => undefined);
      await cleanup("rejected");
    } finally {
      rejectInProgressRef.current = false;
    }
  }, [cleanup, clearProgressTimers, stopRingtone, token]);
  rejectCallRef.current = rejectCall;

  const endCall = useCallback(async (reason?: string) => {
    const currentCall = callRef.current;
    if (!currentCall || !token) { await cleanup("ended"); return; }
    transition("ending");
    if (["dialing", "notifying", "ringing", "preparing"].includes(sessionStateRef.current)) {
      callDebug("call_cancel_source", { call_id: currentCall.id, role: currentCall.direction, source: "user_endCall", state: sessionStateRef.current });
      await callApi.cancel(token, currentCall.id).catch(() => undefined);
    } else {
      callDebug("call_end_source", { call_id: currentCall.id, role: currentCall.direction, source: "user_endCall", end_reason: reason || "user_default" });
      await callApi.end(token, currentCall.id, reason).catch(() => undefined);
    }
    await cleanup("ended");
  }, [cleanup, token, transition]);

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

  const toggleCamera = useCallback(async () => {
    const currentCall = callRef.current;
    if (!currentCall || currentCall.call_type !== "video") return;
    let track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
      track = cameraStream.getVideoTracks()[0];
      localStreamRef.current?.addTrack(track);
      await peerConnectionRef.current?.getSenders().find((sender) => sender.track?.kind === "video")?.replaceTrack(track);
      setLocalStream(localStreamRef.current ? new MediaStream(localStreamRef.current.getTracks()) : cameraStream);
      setCameraEnabled(true);
    } else {
      track.enabled = !track.enabled;
      setCameraEnabled(track.enabled);
    }
    signaling.send("call.media_state", currentCall.id, { camera_enabled: Boolean(track?.enabled), muted });
  }, [muted, signaling]);

  const switchCamera = useCallback(async () => {
    const oldTrack = localStreamRef.current?.getVideoTracks()[0];
    if (!oldTrack) return;
    const currentFacing = oldTrack.getSettings().facingMode;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacing === "environment" ? "user" : { exact: "environment" } }, audio: false });
    const newTrack = stream.getVideoTracks()[0];
    await peerConnectionRef.current?.getSenders().find((sender) => sender.track?.kind === "video")?.replaceTrack(newTrack);
    localStreamRef.current?.removeTrack(oldTrack);
    oldTrack.stop();
    localStreamRef.current?.addTrack(newTrack);
    setLocalStream(localStreamRef.current ? new MediaStream(localStreamRef.current.getTracks()) : stream);
  }, []);

  const toggleSpeaker = useCallback(async () => {
    const next = !speakerEnabled;
    await callNative.setSpeaker(next).catch(() => undefined);
    setSpeakerEnabled(next);
  }, [speakerEnabled]);

  const value = useMemo<CallContextValue>(() => ({
    config,
    signalingState,
    sessionState,
    call,
    peer: call?.peer ?? pendingPeer,
    localStream,
    remoteStream,
    muted,
    cameraEnabled,
    remoteCameraEnabled,
    speakerEnabled,
    networkQuality,
    error,
    refreshRealtime,
    startCall,
    acceptCall,
    rejectCall,
    endCall,
    toggleMute,
    toggleCamera,
    switchCamera,
    toggleSpeaker,
    clearError: () => setError(""),
  }), [acceptCall, call, cameraEnabled, config, endCall, error, localStream, muted, networkQuality, pendingPeer, refreshRealtime, rejectCall, remoteCameraEnabled, remoteStream, sessionState, signalingState, speakerEnabled, startCall, switchCamera, toggleCamera, toggleMute, toggleSpeaker]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

type NativeIncomingAction = "accept" | "reject" | "audio_only";
type NativeIncomingCallEvent = { callId?: string; action?: NativeIncomingAction | null };
