import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { resolveApiAssetUrl } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { syncNativeAccessToken } from "../../auth/sessionStorage";
import { CallContext, type CallContextValue } from "./CallContext";
import { callApi } from "./services/callApi";
import { callNative, nativeRuntimeOwnsMediaSignal, type NativeCallState } from "./services/callNative";
import { canResumeAcceptedCall, requiresAcceptRequest } from "./callAcceptance";
import { CallSetupError, failureCodeOf } from "./callFailures";
import { CallSignaling } from "./services/callSignaling";
import { mediaResourceCoordinator } from "./services/mediaResourceCoordinator";
import { canMarkCallMediaConnected, hasRequiredLocalSenders, syncLocalTracksToPeer } from "./mediaPeer";
import { nextCallState } from "./state/callStateMachine";
import type { CallRecord, CallSessionState, CallSettings, CallType, IncomingCallPayload, PublicCallUser, SignalEnvelope } from "./types";

const TERMINAL_EVENT_STATES: Record<string, CallSessionState> = {
  "call.rejected": "rejected",
  "call.cancelled": "cancelled",
  "call.missed": "missed",
  "call.busy": "busy",
  "call.ended": "ended",
  "call.failed": "failed",
};
const CALL_RECONNECT_GRACE_MS = 15_000;
const CALL_MEDIA_CONNECT_TIMEOUT_MS = 25_000;
const CALL_MEDIA_RECOVERY_TIMEOUT_MS = 10_000;
const CALL_RELAY_UNAVAILABLE_MESSAGE = "Calling network relay is temporarily unavailable.";
const TIMER_NAMES = ["ringing", "noAnswer", "notificationExpiry", "outgoingTimeout", "fcmTimeout", "pendingRetry", "reconnect", "terminal"] as const;
type CallTimerName = typeof TIMER_NAMES[number];

function callDebug(label: string, details: Record<string, unknown> = {}) {
  if (!import.meta.env.DEV && localStorage.getItem("auto-ai-call-debug") !== "true") return;
  console.debug(`[AutoAI Call] ${label}`, { build_version: import.meta.env.VITE_BUILD_VERSION ?? "dev", ...details });
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

function notifyCallHistoryChanged() {
  window.dispatchEvent(new Event("auto-ai-call-history-updated"));
}

export function CallProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
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
  const browserNotificationRef = useRef<Notification | null>(null);
  const eventHandlerRef = useRef<(event: SignalEnvelope) => void>(() => undefined);
  const processNativeCallActionRef = useRef<(callId: string, action?: NativeIncomingAction | null) => Promise<void>>(async () => undefined);
  const cleanupRef = useRef<(terminalState?: CallSessionState, detail?: string) => Promise<void>>(async () => undefined);
  const deviceIdRef = useRef<string | null>(null);
  const startPendingRef = useRef(false);
  const acceptInProgressRef = useRef(false);
  const rejectInProgressRef = useRef(false);
  const endInProgressRef = useRef(false);
  const callEndedRef = useRef(false);
  const cleanupRunningRef = useRef(false);
  const intentionalPeerCloseRef = useRef(false);
  const acceptedCallIdsRef = useRef(new Set<string>());
  const connectedCallIdsRef = useRef(new Set<string>());
  const remoteMediaCallIdsRef = useRef(new Set<string>());
  const nativeServiceCallIdsRef = useRef(new Set<string>());
  const terminalCallIdsRef = useRef(new Set<string>());
  const nativeAcceptIdsRef = useRef(new Set<string>());
  const processedNativeActionIdsRef = useRef(new Set<string>());
  const peerReadyCallIdsRef = useRef(new Set<string>());
  const processedNegotiationIdsRef = useRef(new Set<string>());
  const negotiationIdRef = useRef<string | null>(null);
  const acceptCallRef = useRef<(audioOnly?: boolean) => Promise<void>>(async () => undefined);
  const resumeAcceptedCallRef = useRef<(callId: string, knownCall?: CallRecord) => Promise<void>>(async () => undefined);
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
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const nextConfig = await callApi.config(token);
        setConfig(nextConfig);
        configRef.current = nextConfig;
        if (!nextConfig.enabled) {
          signaling.close();
          return nextConfig;
        }
        if (!nextConfig.realtime_configured) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling is temporarily unavailable.");
        }
        await signaling.retry(token);
        if (!await signaling.waitUntilConnected(6000)) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling could not connect.");
        }
        return nextConfig;
      } catch (refreshError) {
        lastError = refreshError;
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Realtime calling is temporarily unavailable.");
  }, [signaling, token]);

  const verifyCallPreflight = useCallback(async () => {
    if (!token) throw new CallSetupError("SIGNALING_AUTH_FAILED", "Sign in again before starting a call.");
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (callNative.isAndroid()) await syncNativeAccessToken(token);
        const [nextConfig, credentials] = await Promise.all([
          callApi.config(token),
          callApi.turnCredentials(token),
        ]);
        setConfig(nextConfig);
        configRef.current = nextConfig;
        const servers = normalizeIceServers(credentials.iceServers ?? credentials.ice_servers);
        const relayConfigured = Boolean(
          credentials.configured ?? credentials.relayConfigured ?? credentials.relay_configured
        );
        if (!nextConfig.enabled) throw new Error("Calling is disabled.");
        if (!nextConfig.realtime_configured) {
          throw new CallSetupError("SIGNALING_TIMEOUT", "Realtime calling is temporarily unavailable.");
        }
        if (!relayConfigured || !servers.length) {
          throw new CallSetupError("TURN_UNREACHABLE", CALL_RELAY_UNAVAILABLE_MESSAGE);
        }
        turnCredentialsRef.current = {
          iceServers: servers,
          relayConfigured,
          warning: credentials.warning,
          expiresAtMs: Date.now() + 5 * 60_000,
        };
        return;
      } catch (preflightError) {
        lastError = preflightError;
        callDebug("call_preflight_retry", {
          attempt: attempt + 1,
          error_code: failureCodeOf(preflightError, "SIGNALING_TIMEOUT"),
        });
        if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Calling setup is temporarily unavailable.");
  }, [token]);

  const stopRingtone = useCallback(() => {
    window.clearInterval(ringtoneTimerRef.current);
    ringtoneTimerRef.current = 0;
    void ringtoneContextRef.current?.close().catch(() => undefined);
    ringtoneContextRef.current = null;
    navigator.vibrate?.(0);
    document.title = originalTitleRef.current;
  }, []);

  const closeBrowserNotification = useCallback(() => {
    browserNotificationRef.current?.close();
    browserNotificationRef.current = null;
  }, []);

  const ensureNativeCallService = useCallback(async (currentCall: CallRecord, audioOnly = false) => {
    if (nativeServiceCallIdsRef.current.has(currentCall.id)) return;
    const retryableNativeServiceCodes = new Set([
      "SERVICE_READY_TIMEOUT",
      "FOREGROUND_SERVICE_TIMEOUT",
      "FOREGROUND_SERVICE_START_NOT_ALLOWED",
      "SIGNALING_TIMEOUT",
      "NETWORK_LOST",
      "INTERNAL_SERVICE_ERROR",
      "INTERNAL_CALL_ERROR",
    ]);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      nativeServiceCallIdsRef.current.add(currentCall.id);
      try {
        await callNative.startActiveCall({
          callId: currentCall.id,
          displayName: currentCall.peer.display_name,
          startedAt: Date.now(),
          video: currentCall.call_type === "video" && !audioOnly,
        });
        callDebug("native_call_service_started", { call_id: currentCall.id, role: currentCall.direction, state: currentCall.status, attempt: attempt + 1 });
        return;
      } catch (nativeError) {
        nativeServiceCallIdsRef.current.delete(currentCall.id);
        lastError = nativeError;
        const code = failureCodeOf(nativeError, "FOREGROUND_SERVICE_FAILED");
        callDebug("native_call_service_retry", { call_id: currentCall.id, attempt: attempt + 1, error_code: code });
        if (!retryableNativeServiceCodes.has(code) || attempt === 2) break;
        await new Promise((resolve) => window.setTimeout(resolve, 450 * (attempt + 1)));
      }
    }
    throw new CallSetupError("FOREGROUND_SERVICE_FAILED", "Unable to start the Android call service.", lastError);
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
    callDebug("LOCAL_MEDIA_REQUEST_STARTED", { call_id: callRef.current?.id, trace_id: callRef.current?.trace_id, role: callRef.current?.direction, call_type: callType });
    let nativeAudioOnly = audioOnly;
    if (callNative.isAndroid()) {
      const permissions = callType === "video" && !audioOnly
        ? await callNative.requestVideoCallPermissions()
        : await callNative.requestAudioCallPermissions();
      if (!permissions.microphone.granted) {
        throw new Error(permissions.microphone.permanentlyDenied
          ? "Microphone permission is permanently denied. Open Android Settings to allow microphone access."
          : "Microphone permission was denied.");
      }
      if (callType === "video" && !audioOnly && !permissions.camera.granted) {
        nativeAudioOnly = true;
        setError(permissions.camera.permanentlyDenied
          ? "Camera permission is permanently denied. Continuing with audio only."
          : "Camera permission was not granted. Continuing with audio only.");
      }
    }
    await mediaResourceCoordinator.acquire("person-call");
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const dataSaving = Boolean(callSettingsRef.current?.data_saving_mode);
    const video: MediaTrackConstraints | false = callType === "video" && !nativeAudioOnly
      ? { width: { ideal: dataSaving ? 640 : 1280, max: dataSaving ? 640 : 1280 }, height: { ideal: dataSaving ? 360 : 720, max: dataSaving ? 360 : 720 }, frameRate: { ideal: dataSaving ? 18 : 24, max: dataSaving ? 20 : 30 }, facingMode: "user" }
      : false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMuted(false);
      setCameraEnabled(stream.getVideoTracks().some((track) => track.enabled));
      for (const track of stream.getTracks()) callDebug(track.kind === "audio" ? "LOCAL_AUDIO_TRACK_READY" : "LOCAL_VIDEO_TRACK_READY", { call_id: callRef.current?.id, trace_id: callRef.current?.trace_id, role: callRef.current?.direction, kind: track.kind, enabled: track.enabled, muted: track.muted, ready_state: track.readyState });
      if (peerConnectionRef.current && callRef.current) {
        const synced = await syncLocalTracksToPeer(peerConnectionRef.current, stream, callRef.current.call_type);
        for (const track of synced.added) callDebug("LOCAL_TRACK_ATTACHED_TO_PEER", { call_id: callRef.current.id, trace_id: callRef.current.trace_id, role: callRef.current.direction, kind: track.kind, enabled: track.enabled, muted: track.muted, ready_state: track.readyState });
        for (const track of synced.replaced) callDebug("LOCAL_TRACK_REPLACED", { call_id: callRef.current.id, trace_id: callRef.current.trace_id, role: callRef.current.direction, kind: track.kind, enabled: track.enabled, muted: track.muted, ready_state: track.readyState });
      }
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
          if (peerConnectionRef.current && callRef.current) await syncLocalTracksToPeer(peerConnectionRef.current, stream, callRef.current.call_type);
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
      if (localStreamRef.current) await syncLocalTracksToPeer(peer, localStreamRef.current, currentCall.call_type);
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

  const armMediaConnectTimeout = useCallback((callId: string, recoveryAttempt = 0) => {
    setCallTimer("outgoingTimeout", () => {
      if (callRef.current?.id !== callId || !["accepting", "connecting", "reconnecting"].includes(sessionStateRef.current)) return;
      if (recoveryAttempt >= 2) {
        void (async () => {
          await callApi.fail(token || "", callId, "MEDIA_CONNECT_TIMEOUT", deviceIdRef.current).catch(() => undefined);
          await cleanupRef.current("failed", "Media connection timed out. Please try again.");
        })();
        return;
      }
      void attemptReconnect();
      armMediaConnectTimeout(callId, recoveryAttempt + 1);
    }, recoveryAttempt === 0 ? CALL_MEDIA_CONNECT_TIMEOUT_MS : CALL_MEDIA_RECOVERY_TIMEOUT_MS);
  }, [attemptReconnect, setCallTimer, token]);

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
    remoteMediaCallIdsRef.current.delete(currentCall.id);
    if (localStreamRef.current) await syncLocalTracksToPeer(peer, localStreamRef.current, currentCall.call_type);
    const activateIfRemoteMediaReady = () => {
      if (!canMarkCallMediaConnected(peer.connectionState, peer.iceConnectionState, remoteMediaCallIdsRef.current.has(currentCall.id))) return false;
      reconnectAttemptsRef.current = 0;
      clearProgressTimers();
      transition("active");
      if (!connectedCallIdsRef.current.has(currentCall.id)) {
        connectedCallIdsRef.current.add(currentCall.id);
        signaling.send("call.connected", currentCall.id);
        beginStats();
        void ensureNativeCallService(currentCall).catch((nativeError) => {
          callDebug("native_call_service_failed", { call_id: currentCall.id, reason: errorMessage(nativeError, "native start failed") });
        });
      }
      return true;
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream(remoteStreamRef.current?.getTracks() ?? []);
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      const nextRemoteStream = new MediaStream(stream.getTracks());
      remoteStreamRef.current = nextRemoteStream;
      setRemoteStream(nextRemoteStream);
      callDebug("REMOTE_MEDIA_RECEIVED", { call_id: currentCall.id, kind: event.track.kind });
      callDebug(event.track.kind === "audio" ? "REMOTE_AUDIO_TRACK_RECEIVED" : "REMOTE_VIDEO_TRACK_RECEIVED", { call_id: currentCall.id, trace_id: currentCall.trace_id, role: currentCall.direction, kind: event.track.kind, enabled: event.track.enabled, muted: event.track.muted, ready_state: event.track.readyState, receiver_present: true });
      const markRemoteMediaReady = () => {
        remoteMediaCallIdsRef.current.add(currentCall.id);
        callDebug("REMOTE_MEDIA_READY", { call_id: currentCall.id, kind: event.track.kind });
        activateIfRemoteMediaReady();
      };
      event.track.addEventListener("unmute", markRemoteMediaReady, { once: true });
      if (!event.track.muted && event.track.readyState === "live") markRemoteMediaReady();
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
      if (currentCall.direction === "outgoing" && !peerReadyCallIdsRef.current.has(currentCall.id)) {
        callDebug("OFFER_WAITING_FOR_PEER_READY", { call_id: currentCall.id, trace_id: currentCall.trace_id, role: currentCall.direction });
        return;
      }
      try {
        if (localStreamRef.current) await syncLocalTracksToPeer(peer, localStreamRef.current, currentCall.call_type);
        if (!localStreamRef.current || !hasRequiredLocalSenders(peer, currentCall.call_type, currentCall.call_type === "video" && !localStreamRef.current.getVideoTracks().length)) {
          callDebug("OFFER_WAITING_FOR_PEER_READY", { call_id: currentCall.id, trace_id: currentCall.trace_id, role: currentCall.direction, safe_error_code: "LOCAL_AUDIO_SENDER_MISSING" });
          return;
        }
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
        callDebug("CALL_TRANSPORT_CONNECTED", { call_id: currentCall.id });
        if (!activateIfRemoteMediaReady()) transition("connecting");
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
        callDebug("ICE_CONNECTED", { call_id: currentCall.id, state: peer.iceConnectionState });
        if (!activateIfRemoteMediaReady()) transition("connecting");
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
  }, [attemptReconnect, beginStats, clearCallTimer, clearProgressTimers, ensureNativeCallService, loadIceConfiguration, setCallTimer, signaling, transition]);

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
        if (!localStreamRef.current) throw new CallSetupError("INTERNAL_CALL_ERROR", "Local media is not ready.");
        await syncLocalTracksToPeer(peer, localStreamRef.current, currentCall.call_type);
        if (!hasRequiredLocalSenders(peer, currentCall.call_type, currentCall.call_type === "video" && !localStreamRef.current.getVideoTracks().length)) {
          throw new CallSetupError("INTERNAL_CALL_ERROR", "Required local media sender is missing.");
        }
        signaling.send("call.offer_received", currentCall.id, { negotiation_id: negotiationIdRef.current || "", audio_ready: true, video_ready: currentCall.call_type === "audio" || Boolean(localStreamRef.current.getVideoTracks().length) });
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.localDescription) signaling.send("webrtc.answer", currentCall.id, { ...peer.localDescription.toJSON() });
        callDebug("answer_sent", { call_id: currentCall.id, role: currentCall.direction });
      }
      if (description.type === "answer") signaling.send("call.answer_applied", currentCall.id, { negotiation_id: negotiationIdRef.current || "", audio_ready: true, video_ready: currentCall.call_type === "audio" || Boolean(localStreamRef.current?.getVideoTracks().length) });
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
    closeBrowserNotification();
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
    const cleanedCallId = callRef.current?.id;
    if (cleanedCallId) notifyCallHistoryChanged();
    await callNative.stopActiveCall(cleanedCallId).catch(() => undefined);
    if (cleanedCallId) nativeServiceCallIdsRef.current.delete(cleanedCallId);
    if (callNative.isAndroid() && token) void signaling.connect(token);
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
      endInProgressRef.current = false;
    }, terminalState === "ended" ? 900 : 2200);
  }, [clearProgressTimers, closeBrowserNotification, setCallTimer, signaling, stopRingtone, token]);
  cleanupRef.current = cleanup;

  useEffect(() => {
    if (!callNative.isAndroid()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    const applyNativeState = (event: NativeCallState) => {
      if (disposed || !event.callId || event.callId !== callRef.current?.id) return;
      if (event.state === "MEDIA_CONNECTED") transition("active");
      else if (event.state === "RECONNECTING") transition("reconnecting");
      else if (event.state === "TERMINAL") {
        void cleanupRef.current(event.errorCode ? "failed" : "ended",
          event.errorCode ? "The secure media connection could not be established. Please retry." : "");
      } else if (["SERVICE_READY", "SIGNALING_CONNECTING", "SIGNALING_CONNECTED", "MEDIA_CONNECTING"].includes(String(event.state))) {
        transition("connecting");
      }
    };
    void callNative.onNativeCallState(applyNativeState).then((handle) => {
      if (disposed) void handle.remove();
      else listener = handle;
    });
    void callNative.getActiveCallState().then(applyNativeState);
    return () => {
      disposed = true;
      if (listener) void listener.remove();
    };
  }, [transition]);

  const receiveIncomingCall = useCallback(async (callId: string, payload?: IncomingCallPayload) => {
    if (!token) return;
    if (sessionStateRef.current !== "idle") {
      if (callRef.current?.id === callId && sessionStateRef.current === "incoming") return;
      return;
    }
    try {
      const incomingCall = await callApi.get(token, callId);
      if (["accepted", "connecting", "active"].includes(incomingCall.status)) {
        await resumeAcceptedCallRef.current(callId, incomingCall);
        return;
      }
      if (!["initiated", "ringing"].includes(incomingCall.status)) return;
      callEndedRef.current = false;
      rejectInProgressRef.current = false;
      acceptInProgressRef.current = false;
      endInProgressRef.current = false;
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
        closeBrowserNotification();
        const notification = new Notification(`Incoming ${incomingCall.call_type} call`, { body: incomingCall.peer.display_name, icon: resolveApiAssetUrl(incomingCall.peer.avatar_url) || "/icons/icon-192.png", tag: `call-${callId}`, requireInteraction: true });
        browserNotificationRef.current = notification;
        notification.onclick = () => { window.focus(); notification.close(); };
        notification.onclose = () => {
          if (browserNotificationRef.current === notification) browserNotificationRef.current = null;
        };
      }
      clearRingTimer();
      setCallTimer("ringing", () => {
        if (["incoming"].includes(sessionStateRef.current)) void cleanup("missed", "Missed call");
      }, (configRef.current?.ring_timeout_seconds ?? 30) * 1000);
    } catch {
      // Expired or cancelled native notifications are dismissed without showing a stale call.
    }
  }, [cleanup, clearRingTimer, closeBrowserNotification, setCallTimer, signaling, startRingtone, token]);

  useEffect(() => {
    if (!token || signalingState !== "connected" || sessionStateRef.current !== "idle") return;
    let active = true;
    void callApi.pendingIncoming(token).then((pending) => {
      if (active && pending?.id && sessionStateRef.current === "idle") {
        void receiveIncomingCall(pending.id);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [receiveIncomingCall, signalingState, token]);

  const resumeAcceptedCall = useCallback(async (callId: string, knownCall?: CallRecord) => {
    if (!token) return;
    const authoritative = knownCall ?? await callApi.get(token, callId);
    if (!["accepted", "connecting", "active"].includes(authoritative.status)) {
      if (["initiated", "ringing"].includes(authoritative.status)) {
        await receiveIncomingCall(callId);
        return;
      }
      await cleanup("ended", "This call has already ended.");
      return;
    }
    if (callRef.current && callRef.current.id !== callId && !["idle", "ended"].includes(sessionStateRef.current)) return;
    callEndedRef.current = false;
    stopRingtone();
    clearRingTimer();
    clearProgressTimers();
    callRef.current = authoritative;
    setCall(authoritative);
    setPendingPeer(authoritative.peer);
    setError("");
    setSessionState("connecting");
    sessionStateRef.current = "connecting";
    if (!callNative.isAndroid()) navigate(`/calls/active/${encodeURIComponent(callId)}`, { replace: true });
    try {
      if (callNative.isAndroid()) {
        await syncNativeAccessToken(token);
        signaling.close();
      }
      await ensureNativeCallService(authoritative);
      await callNative.acknowledgeCallHandoff(callId).catch(() => undefined);
      callDebug("ACTIVE_CALL_UI_READY", { call_id: callId });
      if (callNative.isAndroid()) return;

      let currentConfig = configRef.current;
      for (let attempt = 0; (!currentConfig?.enabled || !currentConfig.realtime_configured) && attempt < 3; attempt += 1) {
        setSessionState("reconnecting");
        sessionStateRef.current = "reconnecting";
        await new Promise((resolve) => window.setTimeout(resolve, 750 * 2 ** attempt));
        const refreshed = await callApi.get(token, callId).catch(() => null);
        if (refreshed && !["accepted", "connecting", "active"].includes(refreshed.status)) {
          await cleanup("ended", "This call has already ended.");
          return;
        }
        currentConfig = await callApi.config(token).catch(() => currentConfig);
        if (currentConfig) { configRef.current = currentConfig; setConfig(currentConfig); }
      }
      if (!currentConfig?.enabled || !currentConfig.realtime_configured) {
        setSessionState("reconnecting");
        sessionStateRef.current = "reconnecting";
        return;
      }
      let signalingConnected = false;
      for (let attempt = 0; attempt < 3 && !signalingConnected; attempt += 1) {
        if (attempt === 0) await signaling.connect(token); else await signaling.retry(token);
        signalingConnected = await signaling.waitUntilConnected(3000);
      }
      if (!signalingConnected) throw new CallSetupError("SIGNALING_TIMEOUT", "Call signaling is not connected.");
      callDebug("SIGNALING_CONNECTED", { call_id: callId });
      if (!localStreamRef.current) await requestLocalMedia(authoritative.call_type);
      await loadIceConfiguration();
      await ensurePeerConnection(authoritative);
      setSessionState("connecting");
      sessionStateRef.current = "connecting";
      armMediaConnectTimeout(authoritative.id);
      if (authoritative.direction === "incoming") {
        const negotiationId = crypto.randomUUID();
        negotiationIdRef.current = negotiationId;
        signaling.send("call.peer_ready", authoritative.id, {
          call_type: authoritative.call_type,
          audio_ready: Boolean(localStreamRef.current?.getAudioTracks().some((track) => track.readyState === "live")),
          video_ready: authoritative.call_type === "audio" || Boolean(localStreamRef.current?.getVideoTracks().some((track) => track.readyState === "live")),
          negotiation_id: negotiationId,
          revision: authoritative.revision,
        });
      }
    } catch (resumeError) {
      const failureCode = failureCodeOf(resumeError, "INTERNAL_CALL_ERROR");
      setError(errorMessage(resumeError, "Unable to restore the accepted call."));
      setSessionState("failed");
      sessionStateRef.current = "failed";
      await callApi.fail(token, callId, failureCode, deviceIdRef.current).catch(() => undefined);
      await callNative.stopActiveCall(callId).catch(() => undefined);
    }
  }, [armMediaConnectTimeout, cleanup, clearProgressTimers, clearRingTimer, ensureNativeCallService, ensurePeerConnection, loadIceConfiguration, navigate, receiveIncomingCall, requestLocalMedia, signaling, stopRingtone, token]);
  resumeAcceptedCallRef.current = resumeAcceptedCall;

  const processNativeCallAction = useCallback(async (callId: string, action?: NativeIncomingAction | null) => {
    const normalizedAction = action === "accept" || action === "reject" || action === "audio_only" || action === "resume_call" ? action : null;
    const authoritative = token ? await callApi.get(token, callId).catch(() => null) : null;
    if (authoritative && ["accepted", "connecting", "active"].includes(authoritative.status)) {
      await resumeAcceptedCall(callId, authoritative);
      return;
    }
    if (normalizedAction === "resume_call") {
      if (authoritative && ["initiated", "ringing"].includes(authoritative.status)) await receiveIncomingCall(callId);
      else {
        await callNative.stopActiveCall(callId).catch(() => undefined);
        setError("This call has already ended.");
        navigate("/call-hub/calls", { replace: true });
      }
      return;
    }
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
  }, [navigate, receiveIncomingCall, resumeAcceptedCall, token]);
  processNativeCallActionRef.current = processNativeCallAction;

  const handleSignalEvent = useCallback((event: SignalEnvelope) => {
    if (event.type === "presence.user_updated" || event.type === "presence.snapshot") {
      window.dispatchEvent(new CustomEvent("auto-ai-presence-updated", { detail: event.payload }));
    }
    if (event.type === "call.incoming" && event.call_id) {
      void receiveIncomingCall(event.call_id, event.payload as unknown as IncomingCallPayload);
      return;
    }
    if (!event.call_id || event.call_id !== callRef.current?.id) return;
    if (nativeRuntimeOwnsMediaSignal(callNative.isAndroid(), event.type)) {
      callDebug("native_media_signal_ignored_by_webview", { call_id: event.call_id, event_type: event.type });
      return;
    }
    const eventRevision = Number(event.payload.revision || 0);
    const currentRevision = callRef.current?.revision || 0;
    if (eventRevision > 0 && currentRevision > eventRevision) {
      callDebug("stale_revision_ignored", { call_id: event.call_id, event_type: event.type, event_revision: eventRevision, current_revision: currentRevision });
      return;
    }
    if (eventRevision > currentRevision && callRef.current) {
      callRef.current = { ...callRef.current, revision: eventRevision };
      setCall(callRef.current);
    }
    if (event.type === "call.ringing") transition("ringing");
    else if (event.type === "call.accepted") {
      stopRingtone();
      closeBrowserNotification();
      clearProgressTimers();
      transition("connecting");
      callDebug("accepted_received", { call_id: event.call_id, state: sessionStateRef.current, role: callRef.current?.direction });
      if (callRef.current) {
        callRef.current = { ...callRef.current, status: "accepted" };
        setCall(callRef.current);
        if (callNative.isAndroid()) {
          signaling.close();
          void ensureNativeCallService(callRef.current);
        } else {
          void ensurePeerConnection(callRef.current);
          armMediaConnectTimeout(callRef.current.id);
        }
      }
    } else if (event.type === "webrtc.offer" || event.type === "webrtc.answer") void applyDescription(event);
    else if (event.type === "webrtc.ice_candidate") void applyIceCandidate(event);
    else if (event.type === "webrtc.restart_required") void attemptReconnect();
    else if (event.type === "call.peer_ready" && callRef.current?.direction === "outgoing") {
      const negotiationId = String(event.payload.negotiation_id || "");
      if (!negotiationId || processedNegotiationIdsRef.current.has(negotiationId)) return;
      processedNegotiationIdsRef.current.add(negotiationId);
      peerReadyCallIdsRef.current.add(event.call_id);
      negotiationIdRef.current = negotiationId;
      callDebug("PEER_READY_RECEIVED", { call_id: event.call_id, trace_id: callRef.current.trace_id, role: "outgoing", negotiation_id: negotiationId });
      void (async () => {
        const current = callRef.current;
        if (!current) return;
        const peer = await ensurePeerConnection(current);
        if (localStreamRef.current) await syncLocalTracksToPeer(peer, localStreamRef.current, current.call_type);
        if (makingOfferRef.current || peer.signalingState !== "stable") return;
        makingOfferRef.current = true;
        try {
          await peer.setLocalDescription(await peer.createOffer());
          if (peer.localDescription) signaling.send("webrtc.offer", current.id, { ...peer.localDescription.toJSON() });
          armMediaConnectTimeout(current.id);
          callDebug("OFFER_SENT", { call_id: current.id, trace_id: current.trace_id, role: "outgoing", negotiation_id: negotiationId });
        } finally {
          makingOfferRef.current = false;
        }
      })();
    }
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
  }, [applyDescription, applyIceCandidate, armMediaConnectTimeout, attemptReconnect, cleanup, clearProgressTimers, closeBrowserNotification, ensureNativeCallService, ensurePeerConnection, receiveIncomingCall, signaling, stopRingtone, transition]);
  eventHandlerRef.current = handleSignalEvent;

  useEffect(() => {
    if (!token || !user) return;
    let active = true;
    void (async () => {
      const nativeCall: { callId?: string | null; action?: NativeIncomingAction | null } = await callNative.consumeIncomingCall().catch(() => ({}));
      if (nativeCall.callId) await processNativeCallActionRef.current(nativeCall.callId, nativeCall.action);
      const registration = await callNative.registration();
      deviceIdRef.current = registration.device_id;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await callApi.registerDevice(token, registration);
          break;
        } catch (registrationError) {
          callDebug("device_registration_retry", {
            attempt: attempt + 1,
            platform: registration.platform,
            has_fcm_token: Boolean(registration.fcm_token),
            error_code: failureCodeOf(registrationError, "INTERNAL_CALL_ERROR"),
          });
          if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      const [nextConfig, callSettings] = await Promise.all([callApi.config(token), callApi.settings(token)]);
      if (!active) return;
      setConfig(nextConfig);
      configRef.current = nextConfig;
      callSettingsRef.current = callSettings;
      await callNative.requestNotificationPermission().catch(() => undefined);
      if (!nextConfig.enabled || !nextConfig.realtime_configured) {
        signaling.close();
        return;
      }
      if (callNative.isAndroid() && nativeCall.callId) return;
      await signaling.connect(token);
    })().catch((configError) => {
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
        await processNativeCallActionRef.current(detail.callId!, detail.action);
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
  }, [signaling, token, user]);

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
    startPendingRef.current = true;
    callEndedRef.current = false;
    rejectInProgressRef.current = false;
    acceptInProgressRef.current = false;
    endInProgressRef.current = false;
    setError("");
    setPendingPeer(peer);
    setSessionState("preparing");
    sessionStateRef.current = "preparing";
    try {
      await verifyCallPreflight();
      if (callNative.isAndroid()) {
        await syncNativeAccessToken(token);
            const permissions = callType === "video"
              ? await callNative.requestVideoCallPermissions()
              : await callNative.requestAudioCallPermissions();
            if (!permissions.microphone.granted) {
              throw new CallSetupError("MICROPHONE_PERMISSION_DENIED", "Microphone permission is required.");
            }
            if (callType === "video" && !permissions.camera.granted) {
              callType = "audio";
              setError("Camera permission was not granted. Starting an audio call instead.");
            }
            signaling.close();
          } else {
            await signaling.connect(token);
            if (!await signaling.waitUntilConnected()) throw new Error("Secure call signaling could not connect. Please retry.");
            await requestLocalMedia(callType);
          }
          const created = await callApi.initiate(token, peer.id, callType, deviceIdRef.current);
      callRef.current = created;
      setCall(created);
      notifyCallHistoryChanged();
      setSessionState("notifying");
      sessionStateRef.current = "notifying";
      if (callNative.isAndroid()) {
        await ensureNativeCallService(created);
        signaling.close();
      } else {
        void ensureNativeCallService(created).catch((nativeError) => {
          callDebug("native_outgoing_service_failed", {
            call_id: created.id,
            reason: errorMessage(nativeError, "native start failed"),
          });
        });
      }
      if (created.delivery === "unreachable") {
        // Delivery counts are an immediate transport snapshot, not proof that
        // the user is offline. Keep the call alive during the normal ring window;
        // the receiver can recover it after token repair or socket reconnect.
        callDebug("call_delivery_pending", { call_id: created.id, role: created.direction, source: "no_immediate_receiver" });
      }
      clearCallTimer("noAnswer");
      const pollOutgoingStatus = () => {
        setCallTimer("fcmTimeout", async () => {
          if (callRef.current?.id !== created.id || !["dialing", "notifying", "ringing"].includes(sessionStateRef.current)) return;
          const authoritative = await callApi.get(token, created.id).catch(() => null);
          if (authoritative && ["accepted", "connecting", "active"].includes(authoritative.status)) {
            await resumeAcceptedCallRef.current(created.id, authoritative);
            return;
          }
          if (authoritative && ["rejected", "cancelled", "missed", "busy", "failed", "ended"].includes(authoritative.status)) {
            await cleanup(TERMINAL_EVENT_STATES[`call.${authoritative.status}`] ?? "ended", authoritative.end_reason || "");
            return;
          }
          pollOutgoingStatus();
        }, 4_000);
      };
      pollOutgoingStatus();
      setCallTimer("noAnswer", async () => {
        if (callRef.current?.id === created.id && ["dialing", "notifying", "ringing"].includes(sessionStateRef.current)) {
          const authoritative = await callApi.get(token, created.id).catch(() => null);
          if (!authoritative || !["initiated", "ringing"].includes(authoritative.status)) {
            if (authoritative) {
              callRef.current = authoritative;
              setCall(authoritative);
              if (["accepted", "connecting", "active"].includes(authoritative.status)) {
                await resumeAcceptedCallRef.current(created.id, authoritative);
              }
            }
            clearCallTimer("noAnswer");
            return;
          }
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
  }, [cleanup, clearCallTimer, ensureNativeCallService, requestLocalMedia, setCallTimer, signaling, token, verifyCallPreflight]);

  const acceptCall = useCallback(async (audioOnly = false) => {
    const currentCall = callRef.current;
    if (!token || !currentCall || sessionStateRef.current !== "incoming" || startPendingRef.current || acceptInProgressRef.current || rejectInProgressRef.current || callEndedRef.current) return;
    startPendingRef.current = true;
    acceptInProgressRef.current = true;
    stopRingtone();
    closeBrowserNotification();
    clearProgressTimers();
    setSessionState("accepting");
    sessionStateRef.current = "accepting";
    let acceptedSent = false;
    try {
      await verifyCallPreflight();
      const fresh = await callApi.get(token, currentCall.id);
      if (!canResumeAcceptedCall(fresh)) throw new Error("This call is no longer available.");
      callDebug("accepting", { call_id: fresh.id, role: "incoming", state: fresh.status, signaling_connected: signaling.isConnected() });
      if (callNative.isAndroid()) {
        await syncNativeAccessToken(token);
        const permissions = fresh.call_type === "video" && !audioOnly
          ? await callNative.requestVideoCallPermissions()
          : await callNative.requestAudioCallPermissions();
        if (!permissions.microphone.granted) {
          throw new CallSetupError("MICROPHONE_PERMISSION_DENIED", "Microphone permission is required.");
        }
        if (fresh.call_type === "video" && !audioOnly && !permissions.camera.granted) {
          audioOnly = true;
          setError("Camera permission was not granted. Answering with audio only.");
        }
        // Android's foreground service is the sole signaling/media owner once Answer begins.
        signaling.close();
      }
      const accepted = requiresAcceptRequest(fresh)
        ? await callApi.accept(token, fresh.id, deviceIdRef.current)
        : fresh;
      acceptedCallIdsRef.current.add(fresh.id);
      acceptedSent = true;
      callRef.current = accepted;
      setCall(accepted);
      clearProgressTimers();
      await ensureNativeCallService(accepted, audioOnly);
      if (callNative.isAndroid()) {
        await callNative.acknowledgeCallHandoff(accepted.id).catch(() => undefined);
        setSessionState("connecting");
        sessionStateRef.current = "connecting";
        return;
      }
      if (configRef.current?.diagnostic === CALL_RELAY_UNAVAILABLE_MESSAGE) throw new Error(CALL_RELAY_UNAVAILABLE_MESSAGE);
      await signaling.connect(token);
      if (!await signaling.waitUntilConnected()) throw new Error("Call signaling is not connected.");
      await requestLocalMedia(fresh.call_type, audioOnly);
      callDebug("local_media_ready", {
        call_id: fresh.id,
        audio_tracks: localStreamRef.current?.getAudioTracks().length ?? 0,
        video_tracks: localStreamRef.current?.getVideoTracks().length ?? 0,
      });
      await loadIceConfiguration();
      setSessionState("connecting");
      sessionStateRef.current = "connecting";
      callDebug("accepted_sent", { call_id: accepted.id, role: "incoming", signaling_connected: signaling.isConnected() });
      await ensurePeerConnection(accepted);
      const negotiationId = crypto.randomUUID();
      negotiationIdRef.current = negotiationId;
      signaling.send("call.peer_ready", accepted.id, {
        call_type: accepted.call_type,
        audio_ready: Boolean(localStreamRef.current?.getAudioTracks().some((track) => track.readyState === "live")),
        video_ready: accepted.call_type === "audio" || Boolean(localStreamRef.current?.getVideoTracks().some((track) => track.readyState === "live")),
        audio_only: accepted.call_type === "video" && !localStreamRef.current?.getVideoTracks().length,
        negotiation_id: negotiationId,
        revision: accepted.revision,
      });
      armMediaConnectTimeout(accepted.id);
    } catch (acceptError) {
      acceptedCallIdsRef.current.delete(currentCall.id);
      if (acceptedSent) {
        const detail = errorMessage(acceptError, "Call setup was interrupted.");
        callDebug("accept_recovery_started", { call_id: currentCall.id, role: currentCall.direction, source: "accept_post_accept_failure", error_code: "SIGNALING_SETUP_INTERRUPTED" });
        setError(detail);
        setSessionState("reconnecting");
        sessionStateRef.current = "reconnecting";
        setCallTimer("pendingRetry", async () => {
          try {
            const authoritative = await callApi.get(token, currentCall.id);
            if (!["accepted", "connecting", "active"].includes(authoritative.status)) throw new Error("Call is no longer active.");
            callRef.current = authoritative;
            setCall(authoritative);
            if (callNative.isAndroid()) {
              await syncNativeAccessToken(token);
              signaling.close();
              await ensureNativeCallService(authoritative);
              await callNative.acknowledgeCallHandoff(authoritative.id).catch(() => undefined);
            } else {
              await signaling.retry(token);
              if (!await signaling.waitUntilConnected(8000)) throw new Error("Signaling reconnect timed out.");
              await ensureNativeCallService(authoritative);
              await loadIceConfiguration();
              await ensurePeerConnection(authoritative);
            }
            setError("");
            transition("connecting");
          } catch (recoveryError) {
            const failureCode = failureCodeOf(recoveryError, "SIGNALING_TIMEOUT");
            callDebug("accept_recovery_failed", { call_id: currentCall.id, role: currentCall.direction, error_code: failureCode });
            await callApi.fail(token, currentCall.id, failureCode, deviceIdRef.current).catch((failureReportError) => {
              callDebug("call_failure_report_failed", {
                call_id: currentCall.id,
                role: currentCall.direction,
                error_code: "INTERNAL_CALL_ERROR",
                reason: errorMessage(failureReportError, "failure report failed"),
              });
            });
            await cleanup("failed", errorMessage(recoveryError, "Unable to reconnect call signaling."));
          }
        }, 1500);
        return;
      } else {
        callDebug("accept_setup_failed_no_reject", { call_id: currentCall.id, role: currentCall.direction, state: sessionStateRef.current });
      }
      await cleanup("failed", errorMessage(acceptError, "Unable to accept the call."));
    } finally {
      startPendingRef.current = false;
      acceptInProgressRef.current = false;
    }
  }, [armMediaConnectTimeout, cleanup, clearProgressTimers, closeBrowserNotification, ensureNativeCallService, ensurePeerConnection, loadIceConfiguration, requestLocalMedia, setCallTimer, signaling, stopRingtone, token, transition, verifyCallPreflight]);
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
    if (endInProgressRef.current || cleanupRunningRef.current || callEndedRef.current) return;
    endInProgressRef.current = true;
    const stateAtEnd = sessionStateRef.current;
    setSessionState("ending");
    sessionStateRef.current = "ending";
    stopRingtone();
    closeBrowserNotification();
    clearProgressTimers();
    let terminalRequest: Promise<unknown>;
    if (["dialing", "notifying", "ringing", "preparing"].includes(stateAtEnd)) {
      callDebug("call_cancel_source", { call_id: currentCall.id, role: currentCall.direction, source: "user_endCall", state: stateAtEnd });
      signaling.send("call.cancel", currentCall.id);
      terminalRequest = callApi.cancel(token, currentCall.id).catch(async (cancelError) => {
        const authoritative = await callApi.get(token, currentCall.id).catch(() => null);
        if (authoritative && ["accepted", "connecting", "active"].includes(authoritative.status)) {
          return callApi.end(token, currentCall.id, reason);
        }
        throw cancelError;
      });
    } else {
      callDebug("call_end_source", { call_id: currentCall.id, role: currentCall.direction, source: "user_endCall", end_reason: reason || "user_default" });
      signaling.send("call.end", currentCall.id, { end_reason: reason || "" });
      terminalRequest = callApi.end(token, currentCall.id, reason);
    }
    await cleanup("ended");
    await terminalRequest.catch((terminalError) => {
      callDebug("terminal_sync_failed", { call_id: currentCall.id, reason: errorMessage(terminalError, "terminal request failed") });
    });
  }, [cleanup, clearProgressTimers, closeBrowserNotification, signaling, stopRingtone, token]);

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
      if (peerConnectionRef.current && localStreamRef.current) await syncLocalTracksToPeer(peerConnectionRef.current, localStreamRef.current, currentCall.call_type);
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
    localStreamRef.current?.removeTrack(oldTrack);
    oldTrack.stop();
    localStreamRef.current?.addTrack(newTrack);
    if (peerConnectionRef.current && localStreamRef.current && callRef.current) await syncLocalTracksToPeer(peerConnectionRef.current, localStreamRef.current, callRef.current.call_type);
    setLocalStream(localStreamRef.current ? new MediaStream(localStreamRef.current.getTracks()) : stream);
  }, []);

  const toggleSpeaker = useCallback(async () => {
    const next = !speakerEnabled;
    await callNative.setAudioRoute(next ? "speaker" : "earpiece").catch(() => callNative.setSpeaker(next).catch(() => undefined));
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

type NativeIncomingAction = "accept" | "reject" | "audio_only" | "resume_call";
type NativeIncomingCallEvent = { callId?: string; action?: NativeIncomingAction | null };
