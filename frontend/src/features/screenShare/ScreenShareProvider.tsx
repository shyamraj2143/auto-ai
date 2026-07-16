import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../contexts/AuthContext";
import type { PublicCallUser } from "../calls/types";
import { screenShareApi, ScreenShareSignaling } from "./screenShareApi";
import { ScreenShareContext, type ScreenShareContextValue } from "./ScreenShareContext";
import { screenShareDebug } from "./screenShareDiagnostics";
import { isNativeScreenCapturePlatform, startNativeScreenCaptureStream } from "./nativeScreenCapture";
import type { ScreenShareInvite, ScreenShareQualityMode, ScreenShareRole, ScreenShareSession, ScreenShareSignal, ScreenShareSource, ScreenShareUiState } from "./types";

const RECONNECT_LIMIT = 3;
const SCREEN_UNSUPPORTED_MESSAGE = "Screen sharing is not supported in this browser. Use Chrome desktop or the AutoAI Android app to generate a code. You can still join with a code from this device.";
const MIC_UNSUPPORTED_MESSAGE = "Microphone is not available in this browser.";
type NetworkQuality = "good" | "poor" | "reconnecting" | "unknown";

type QualityProfile = {
  contentHint: "text" | "detail" | "motion";
  maxBitrate: number;
  maxFramerate: number;
  scaleResolutionDownBy: number;
  nativeLongEdge: number;
  nativeJpegQuality: number;
};

const QUALITY_PROFILES: Record<ScreenShareQualityMode, QualityProfile> = {
  auto: { contentHint: "detail", maxBitrate: 2_400_000, maxFramerate: 18, scaleResolutionDownBy: 1, nativeLongEdge: 1920, nativeJpegQuality: 78 },
  "data-saver": { contentHint: "text", maxBitrate: 900_000, maxFramerate: 10, scaleResolutionDownBy: 1.75, nativeLongEdge: 1080, nativeJpegQuality: 64 },
  "sharp-text": { contentHint: "detail", maxBitrate: 3_200_000, maxFramerate: 18, scaleResolutionDownBy: 1, nativeLongEdge: 2160, nativeJpegQuality: 82 },
  "smooth-motion": { contentHint: "motion", maxBitrate: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1.35, nativeLongEdge: 1440, nativeJpegQuality: 72 },
  hd: { contentHint: "detail", maxBitrate: 4_200_000, maxFramerate: 24, scaleResolutionDownBy: 1, nativeLongEdge: 2400, nativeJpegQuality: 84 },
};

function sessionIdOf(session: ScreenShareSession | null) {
  return session?.sessionId ?? session?.session_id ?? "";
}

function inviteLinkOf(session: ScreenShareSession | null) {
  return session?.inviteLink ?? session?.invite_link ?? "";
}

function shareCodeOf(session: ScreenShareSession | null) {
  return session?.shareCode ?? session?.share_code ?? "";
}

function normalizeIceServers(iceServers?: RTCIceServer[]) {
  return (iceServers ?? []).filter((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => typeof url === "string" && /^(stun|turns?):/.test(url));
  });
}

function eventSessionId(event: ScreenShareSignal) {
  return event.session_id ?? event.sessionId ?? "";
}

function sourceConstraint(source: ScreenShareSource): DisplayMediaStreamOptions {
  const displaySurface = source === "window" ? "window" : source === "browser" ? "browser" : "monitor";
  return {
    video: { displaySurface, frameRate: { ideal: 24, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } } as MediaTrackConstraints,
    audio: false,
  };
}

function nativeOptionsFor(mode: ScreenShareQualityMode) {
  const profile = QUALITY_PROFILES[mode];
  return {
    frameRate: profile.maxFramerate,
    maxLongEdge: profile.nativeLongEdge,
    jpegQuality: profile.nativeJpegQuality,
  };
}

function microphoneConstraint(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } as MediaTrackConstraints,
    video: false,
  };
}

function isScreenShareSupported() {
  return (typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia) || isNativeScreenCapturePlatform();
}

function screenCaptureErrorMessage(error: unknown) {
  if (!isScreenShareSupported()) return SCREEN_UNSUPPORTED_MESSAGE;
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Screen sharing permission was denied.";
  if (error instanceof DOMException && error.name === "NotFoundError") return "No screen, window, or tab was available to share.";
  return error instanceof Error ? error.message : "Screen sharing could not start.";
}

function microphoneErrorMessage(error: unknown) {
  if (!navigator.mediaDevices?.getUserMedia) return MIC_UNSUPPORTED_MESSAGE;
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Microphone permission was denied.";
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone was found.";
  return error instanceof Error ? error.message : "Microphone could not start.";
}

export function ScreenShareProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const [uiState, setUiState] = useState<ScreenShareUiState>("idle");
  const [role, setRole] = useState<ScreenShareRole | null>(null);
  const [session, setSession] = useState<ScreenShareSession | null>(null);
  const [requestPeer, setRequestPeer] = useState<PublicCallUser | null>(null);
  const [inviteOnlyRequest, setInviteOnlyRequest] = useState(false);
  const [pendingInvite, setPendingInvite] = useState<ScreenShareInvite | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [canShareScreen] = useState(isScreenShareSupported);
  const [qualityMode, setQualityModeState] = useState<ScreenShareQualityMode>("auto");
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>("unknown");
  const [sentResolution, setSentResolution] = useState("");
  const tokenRef = useRef(token);
  const roleRef = useRef<ScreenShareRole | null>(null);
  const sessionRef = useRef<ScreenShareSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const nativeScreenStopRef = useRef<(() => Promise<void>) | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const eventHandlerRef = useRef<(event: ScreenShareSignal) => void>(() => undefined);
  const createOfferRef = useRef<(iceRestart?: boolean) => Promise<void>>(async () => undefined);
  const qualityModeRef = useRef<ScreenShareQualityMode>("auto");
  const applyQualityRef = useRef<(peer?: RTCPeerConnection | null, mode?: ScreenShareQualityMode) => Promise<void>>(async () => undefined);
  const statsRef = useRef<{ timestamp: number; bytes: number; packetsLost: number; packetsReceived: number } | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  tokenRef.current = token;
  roleRef.current = role;
  sessionRef.current = session;
  localStreamRef.current = localStream;
  remoteStreamRef.current = remoteStream;
  qualityModeRef.current = qualityMode;

  const signaling = useMemo(
    () => new ScreenShareSignaling((event) => eventHandlerRef.current(event), (state) => {
      if (state === "error" && sessionRef.current) setUiState("reconnecting");
    }),
    [],
  );

  const closePeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    pendingIceRef.current = [];
  }, []);

  const stopLocalTracks = useCallback(() => {
    const stopNativeScreen = nativeScreenStopRef.current;
    nativeScreenStopRef.current = null;
    if (stopNativeScreen) void stopNativeScreen();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  const startDisplayStream = useCallback(async (source: ScreenShareSource) => {
    if (navigator.mediaDevices?.getDisplayMedia) {
      return navigator.mediaDevices.getDisplayMedia(sourceConstraint(source));
    }
    const nativeCapture = await startNativeScreenCaptureStream(nativeOptionsFor(qualityModeRef.current));
    nativeScreenStopRef.current = nativeCapture.stop;
    return nativeCapture.stream;
  }, []);

  const reset = useCallback((nextState: ScreenShareUiState = "idle") => {
    closePeer();
    stopLocalTracks();
    remoteStreamRef.current = null;
    setRemoteStream(null);
    setSession(null);
    setRole(null);
    setRequestPeer(null);
    setInviteOnlyRequest(false);
    setPendingInvite(null);
    setStartedAt(null);
    setShareCode(null);
    setPaused(false);
    setMuted(true);
    setUiState(nextState);
  }, [closePeer, stopLocalTracks]);

  const ensureSignaling = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!currentToken) throw new Error("Not authenticated");
    await signaling.connect(currentToken);
    if (!await signaling.waitUntilConnected()) throw new Error("Screen share signaling is not connected.");
  }, [signaling]);

  const ensurePeer = useCallback(async () => {
    if (peerRef.current) return peerRef.current;
    const currentToken = tokenRef.current;
    if (!currentToken) throw new Error("Not authenticated");
    const credentials = await screenShareApi.turnCredentials(currentToken);
    const iceServers = normalizeIceServers(credentials.iceServers ?? credentials.ice_servers);
    if (!iceServers.length) throw new Error("Screen sharing network relay is temporarily unavailable.");
    const peer = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    peerRef.current = peer;
    localStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, localStreamRef.current!));
    void applyQualityRef.current(peer);
    peer.onicecandidate = (event) => {
      const id = sessionIdOf(sessionRef.current);
      if (event.candidate && id) signaling.send("ice-candidate", id, { ...event.candidate.toJSON() });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream(remoteStreamRef.current?.getTracks() ?? []);
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      const next = new MediaStream(stream.getTracks());
      remoteStreamRef.current = next;
      setRemoteStream(next);
      setUiState("active");
      setStartedAt((value) => value ?? Date.now());
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        reconnectAttemptsRef.current = 0;
        setNetworkQuality("good");
        setUiState("active");
      } else if (["disconnected", "failed"].includes(peer.connectionState)) {
        setNetworkQuality("reconnecting");
        setUiState("reconnecting");
        const id = sessionIdOf(sessionRef.current);
        if (roleRef.current === "sharer" && id && reconnectAttemptsRef.current < RECONNECT_LIMIT) {
          reconnectAttemptsRef.current += 1;
          window.setTimeout(() => void createOfferRef.current(true), 1000 * reconnectAttemptsRef.current);
        } else if (reconnectAttemptsRef.current >= RECONNECT_LIMIT) {
          setUiState("failed");
          setNetworkQuality("poor");
          setError("Screen share connection failed. Please start a new share.");
        }
      } else if (peer.connectionState === "closed") {
        setUiState((current) => current === "idle" ? "idle" : "ended");
      }
    };
    return peer;
  }, [signaling]);

  const createOffer = useCallback(async (iceRestart = false) => {
    const id = sessionIdOf(sessionRef.current);
    if (!id) return;
    const peer = await ensurePeer();
    const offer = await peer.createOffer({ iceRestart });
    await peer.setLocalDescription(offer);
    signaling.send("offer", id, { type: offer.type, sdp: offer.sdp || "" });
  }, [ensurePeer, signaling]);
  createOfferRef.current = createOffer;

  const applyQuality = useCallback(async (peer: RTCPeerConnection | null = peerRef.current, mode: ScreenShareQualityMode = qualityModeRef.current) => {
    const profile = QUALITY_PROFILES[mode];
    const videoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (!videoTrack) return;
    try {
      videoTrack.contentHint = profile.contentHint;
    } catch {
      // Some WebViews ignore contentHint.
    }
    const settings = videoTrack.getSettings();
    setSentResolution(settings.width && settings.height ? `${settings.width} x ${settings.height}` : "");
    screenShareDebug("sender-track-settings", {
      width: settings.width,
      height: settings.height,
      aspectRatio: settings.aspectRatio,
      frameRate: settings.frameRate,
      contentHint: videoTrack.contentHint,
      qualityMode: mode,
    });
    const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
    if (sender) {
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0] = {
          ...params.encodings[0],
          maxBitrate: profile.maxBitrate,
          maxFramerate: profile.maxFramerate,
          scaleResolutionDownBy: Math.max(1, profile.scaleResolutionDownBy),
        };
        await sender.setParameters(params);
        screenShareDebug("sender-encoding-params", {
          maxBitrate: params.encodings?.[0]?.maxBitrate,
          maxFramerate: params.encodings?.[0]?.maxFramerate,
          scaleResolutionDownBy: params.encodings?.[0]?.scaleResolutionDownBy,
        });
      } catch {
        await videoTrack.applyConstraints({ frameRate: { ideal: profile.maxFramerate, max: profile.maxFramerate } }).catch(() => undefined);
      }
    }
  }, []);
  applyQualityRef.current = applyQuality;

  const setQualityMode = useCallback((mode: ScreenShareQualityMode) => {
    qualityModeRef.current = mode;
    setQualityModeState(mode);
    void applyQuality(peerRef.current, mode);
  }, [applyQuality]);

  const applyPendingIce = useCallback(async () => {
    const peer = peerRef.current;
    if (!peer?.remoteDescription) return;
    const candidates = pendingIceRef.current.splice(0);
    for (const candidate of candidates) {
      await peer.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const stopShare = useCallback(async () => {
    const currentToken = tokenRef.current;
    const id = sessionIdOf(sessionRef.current);
    if (id) signaling.send("screen-share-ended", id);
    closePeer();
    stopLocalTracks();
    if (currentToken && id) await screenShareApi.endSession(currentToken, id).catch(() => undefined);
    reset("ended");
  }, [closePeer, reset, signaling, stopLocalTracks]);

  const handleSignalEvent = useCallback((event: ScreenShareSignal) => {
    if (event.type === "screen-share-invite") {
      const payload = event.payload as Partial<ScreenShareInvite>;
      if (payload.sessionId && payload.sharer) setPendingInvite(payload as ScreenShareInvite);
      return;
    }
    const id = sessionIdOf(sessionRef.current);
    if (!id || eventSessionId(event) !== id) return;
    if (event.type === "join-session") {
      if (roleRef.current === "sharer" && localStreamRef.current) {
        void createOffer();
      }
    } else if (event.type === "offer") {
      void (async () => {
        const peer = await ensurePeer();
        await peer.setRemoteDescription(new RTCSessionDescription(event.payload as unknown as RTCSessionDescriptionInit));
        await applyPendingIce();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        signaling.send("answer", id, { type: answer.type, sdp: answer.sdp || "" });
      })().catch((offerError) => setError(offerError instanceof Error ? offerError.message : "Unable to join screen share."));
    } else if (event.type === "answer") {
      void peerRef.current?.setRemoteDescription(new RTCSessionDescription(event.payload as unknown as RTCSessionDescriptionInit))
        .then(applyPendingIce)
        .catch(() => setError("Unable to connect screen share."));
    } else if (event.type === "ice-candidate") {
      const candidate = event.payload as RTCIceCandidateInit;
      if (peerRef.current?.remoteDescription) void peerRef.current.addIceCandidate(candidate).catch(() => undefined);
      else pendingIceRef.current.push(candidate);
    } else if (event.type === "screen-share-started") {
      setUiState((current) => current === "idle" ? "connecting" : current);
    } else if (event.type === "screen-share-paused") {
      setPaused(true);
    } else if (event.type === "screen-share-resumed") {
      setPaused(false);
    } else if (event.type === "screen-share-ended" || event.type === "screen-share-declined") {
      reset("ended");
    } else if (event.type === "screen-share-error") {
      setError(String(event.payload.detail || "Screen share error"));
    }
  }, [applyPendingIce, createOffer, ensurePeer, reset, signaling]);

  eventHandlerRef.current = handleSignalEvent;

  useEffect(() => {
    if (!token || !user) {
      signaling.close();
      reset("idle");
      return;
    }
    void signaling.connect(token);
    return () => signaling.close();
  }, [reset, signaling, token, user]);

  useEffect(() => {
    const unload = () => {
      const id = sessionIdOf(sessionRef.current);
      if (id) signaling.send("screen-share-ended", id);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [signaling]);

  const requestShare = useCallback((peer: PublicCallUser) => {
    setError("");
    setInviteOnlyRequest(false);
    setRequestPeer(peer);
  }, []);

  const enableMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(MIC_UNSUPPORTED_MESSAGE);
    const audioStream = await navigator.mediaDevices.getUserMedia(microphoneConstraint());
    const audioTrack = audioStream.getAudioTracks()[0];
    if (!audioTrack) throw new Error("No microphone audio track was created.");
    audioTrack.enabled = true;
    const nextStream = localStreamRef.current ?? new MediaStream();
    nextStream.getAudioTracks().forEach((track) => {
      track.stop();
      nextStream.removeTrack(track);
    });
    nextStream.addTrack(audioTrack);
    audioTrack.addEventListener("ended", () => {
      nextStream.removeTrack(audioTrack);
      localStreamRef.current = nextStream;
      setLocalStream(new MediaStream(nextStream.getTracks()));
      setMuted(true);
    });
    localStreamRef.current = nextStream;
    setLocalStream(nextStream);
    setMuted(false);
    const peer = peerRef.current;
    if (peer) {
      const audioSender = peer.getSenders().find((sender) => sender.track?.kind === "audio");
      if (audioSender) await audioSender.replaceTrack(audioTrack);
      else peer.addTrack(audioTrack, nextStream);
    }
    if (peer?.remoteDescription && peer.signalingState === "stable") {
      await createOfferRef.current(false);
    }
  }, []);

  const requestInviteShare = useCallback(() => {
    setError("");
    setRequestPeer(null);
    setInviteOnlyRequest(true);
  }, []);

  const cancelRequest = useCallback(() => {
    setRequestPeer(null);
    setInviteOnlyRequest(false);
  }, []);

  const startShare = useCallback(async (source: ScreenShareSource) => {
    const currentToken = tokenRef.current;
    const peer = requestPeer;
    if (!currentToken || (!peer && !inviteOnlyRequest)) return;
    if (!canShareScreen) {
      setError(SCREEN_UNSUPPORTED_MESSAGE);
      return;
    }
    setUiState("preparing");
    setError("");
    try {
      const stream = await startDisplayStream(source);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => void stopShare());
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMuted(true);
      await applyQuality(null);
      const created = await screenShareApi.createSession(currentToken, {
        viewer_user_id: peer?.id ?? null,
        invite_link: true,
        expires_minutes: 60,
      });
      setSession(created);
      setRole("sharer");
      setShareCode(null);
      setRequestPeer(null);
      setInviteOnlyRequest(false);
      setStartedAt(Date.now());
      setUiState("waiting");
      await ensureSignaling();
      const id = sessionIdOf(created);
      signaling.send("join-session", id);
      signaling.send("screen-share-started", id);
    } catch (shareError) {
      stopLocalTracks();
      setUiState("idle");
      setError(screenCaptureErrorMessage(shareError));
    }
  }, [applyQuality, canShareScreen, ensureSignaling, inviteOnlyRequest, requestPeer, signaling, startDisplayStream, stopLocalTracks, stopShare]);

  const generateShareCode = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!currentToken || (!inviteOnlyRequest && !requestPeer)) return;
    if (!canShareScreen) {
      setError(SCREEN_UNSUPPORTED_MESSAGE);
      return;
    }
    setUiState("preparing");
    setError("");
    try {
      const stream = await startDisplayStream("screen");
      stream.getVideoTracks()[0]?.addEventListener("ended", () => void stopShare());
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMuted(true);
      await applyQuality(null);
      const created = await screenShareApi.createSession(currentToken, {
        viewer_user_id: null,
        invite_link: false,
        code_mode: true,
        expires_minutes: 60,
      });
      setSession(created);
      setRole("sharer");
      setShareCode(shareCodeOf(created));
      setRequestPeer(null);
      setInviteOnlyRequest(false);
      setStartedAt(Date.now());
      setUiState("waiting");
      await ensureSignaling();
      const id = sessionIdOf(created);
      signaling.send("join-session", id);
      signaling.send("screen-share-started", id);
    } catch (shareError) {
      stopLocalTracks();
      setUiState("idle");
      setError(screenCaptureErrorMessage(shareError));
    }
  }, [applyQuality, canShareScreen, ensureSignaling, inviteOnlyRequest, requestPeer, signaling, startDisplayStream, stopLocalTracks, stopShare]);

  useEffect(() => {
    if (!session || !peerRef.current) {
      statsRef.current = null;
      setNetworkQuality("unknown");
      return;
    }
    const timer = window.setInterval(async () => {
      const peer = peerRef.current;
      if (!peer) return;
      try {
        const report = await peer.getStats();
        let poor = false;
        let nextSentResolution = sentResolution;
        report.forEach((stat) => {
          if (stat.type === "outbound-rtp" && stat.kind === "video") {
            screenShareDebug("outbound-video-stats", {
              frameWidth: stat.frameWidth,
              frameHeight: stat.frameHeight,
              framesPerSecond: stat.framesPerSecond,
              framesEncoded: stat.framesEncoded,
              bytesSent: stat.bytesSent,
              packetsSent: stat.packetsSent,
              qualityLimitationReason: stat.qualityLimitationReason,
            });
            if (typeof stat.frameWidth === "number" && typeof stat.frameHeight === "number") {
              nextSentResolution = `${stat.frameWidth} x ${stat.frameHeight}`;
            }
            const previous = statsRef.current;
            if (previous && typeof stat.bytesSent === "number") {
              const seconds = Math.max(0.5, (stat.timestamp - previous.timestamp) / 1000);
              const bitrate = ((stat.bytesSent - previous.bytes) * 8) / seconds;
              poor = bitrate < 220_000;
            }
            statsRef.current = {
              timestamp: stat.timestamp,
              bytes: typeof stat.bytesSent === "number" ? stat.bytesSent : 0,
              packetsLost: 0,
              packetsReceived: 0,
            };
          }
          if (stat.type === "candidate-pair" && stat.state === "succeeded" && typeof stat.currentRoundTripTime === "number") {
            screenShareDebug("candidate-pair-stats", {
              currentRoundTripTime: stat.currentRoundTripTime,
              availableOutgoingBitrate: stat.availableOutgoingBitrate,
            });
            poor = poor || stat.currentRoundTripTime > 0.65;
          }
          if (stat.type === "inbound-rtp" && stat.kind === "video") {
            screenShareDebug("inbound-video-stats", {
              frameWidth: stat.frameWidth,
              frameHeight: stat.frameHeight,
              framesPerSecond: stat.framesPerSecond,
              framesDecoded: stat.framesDecoded,
              framesDropped: stat.framesDropped,
              packetsLost: stat.packetsLost,
              jitter: stat.jitter,
              freezeCount: stat.freezeCount,
              bytesReceived: stat.bytesReceived,
            });
            const lost = typeof stat.packetsLost === "number" ? stat.packetsLost : 0;
            const received = typeof stat.packetsReceived === "number" ? stat.packetsReceived : 0;
            if (received > 0 && lost / (lost + received) > 0.08) poor = true;
          }
        });
        if (nextSentResolution !== sentResolution) setSentResolution(nextSentResolution);
        setNetworkQuality(peer.connectionState === "connected" ? (poor ? "poor" : "good") : "reconnecting");
        if (qualityModeRef.current === "auto" && poor) {
          await applyQuality(peer, "data-saver");
        }
      } catch {
        setNetworkQuality("unknown");
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [applyQuality, session, sentResolution]);

  const joinBySession = useCallback(async (sessionId: string, inviteToken?: string | null) => {
    const currentToken = tokenRef.current;
    if (!currentToken || !sessionId) return;
    setUiState("connecting");
    setError("");
    try {
      const nextSession = await screenShareApi.getSession(currentToken, sessionId, inviteToken);
      setSession(nextSession);
      setRole("viewer");
      setShareCode(null);
      setPendingInvite(null);
      setRequestPeer(null);
      setInviteOnlyRequest(false);
      await ensureSignaling();
      signaling.send("join-session", sessionId, inviteToken ? { inviteToken } : {});
      await ensurePeer();
    } catch (joinError) {
      setUiState("failed");
      setError(joinError instanceof Error ? joinError.message : "Unable to join screen share.");
    }
  }, [ensurePeer, ensureSignaling, signaling]);

  const joinWithCode = useCallback(async (code: string) => {
    const currentToken = tokenRef.current;
    const normalizedCode = code.replace(/\D/g, "").slice(0, 8);
    if (!currentToken || normalizedCode.length !== 8) {
      setError("Enter an 8 digit screen share code.");
      return;
    }
    setUiState("connecting");
    setError("");
    try {
      const nextSession = await screenShareApi.joinCode(currentToken, normalizedCode);
      const id = sessionIdOf(nextSession);
      setSession(nextSession);
      setRole("viewer");
      setShareCode(null);
      setPendingInvite(null);
      setRequestPeer(null);
      setInviteOnlyRequest(false);
      await ensureSignaling();
      signaling.send("join-session", id);
      await ensurePeer();
    } catch (joinError) {
      setUiState("failed");
      setError(joinError instanceof Error ? joinError.message : "Unable to join screen share.");
    }
  }, [ensurePeer, ensureSignaling, signaling]);

  const joinInvite = useCallback(async (invite?: ScreenShareInvite | null) => {
    const selected = invite ?? pendingInvite;
    if (!selected) return;
    await joinBySession(selected.sessionId);
  }, [joinBySession, pendingInvite]);

  const joinInviteLink = useCallback(async (sessionId: string, inviteToken?: string | null) => {
    await joinBySession(sessionId, inviteToken);
  }, [joinBySession]);

  const declineInvite = useCallback(async () => {
    const invite = pendingInvite;
    if (!invite) return;
    signaling.send("screen-share-declined", invite.sessionId);
    setPendingInvite(null);
  }, [pendingInvite, signaling]);

  const toggleMute = useCallback(async () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track?.readyState === "ended") {
      localStreamRef.current?.removeTrack(track);
      await enableMicrophone();
      return;
    }
    if (!track) {
      setError("");
      try {
        await enableMicrophone();
      } catch (micError) {
        setMuted(true);
        setError(microphoneErrorMessage(micError));
      }
      return;
    }
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, [enableMicrophone]);

  const togglePause = useCallback(() => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    const id = sessionIdOf(sessionRef.current);
    if (!track || !id) return;
    track.enabled = !track.enabled;
    setPaused(!track.enabled);
    signaling.send(track.enabled ? "screen-share-resumed" : "screen-share-paused", id);
  }, [signaling]);

  const copyInviteLink = useCallback(async () => {
    const link = inviteLinkOf(sessionRef.current);
    if (link) await navigator.clipboard.writeText(link);
  }, []);

  const copyShareCode = useCallback(async () => {
    const code = shareCode || shareCodeOf(sessionRef.current);
    if (code) await navigator.clipboard.writeText(code);
  }, [shareCode]);

  const value = useMemo<ScreenShareContextValue>(() => ({
    uiState,
    role,
    session,
    requestPeer,
    inviteOnlyRequest,
    requestInviteShare,
    pendingInvite,
    localStream,
    remoteStream,
    error,
    muted,
    paused,
    startedAt,
    shareCode,
    canShareScreen,
    qualityMode,
    networkQuality,
    sentResolution,
    setQualityMode,
    requestShare,
    cancelRequest,
    startShare,
    generateShareCode,
    joinWithCode,
    joinInvite,
    joinInviteLink,
    declineInvite,
    stopShare,
    toggleMute,
    togglePause,
    copyInviteLink,
    copyShareCode,
    clearError: () => setError(""),
  }), [canShareScreen, cancelRequest, copyInviteLink, copyShareCode, declineInvite, error, generateShareCode, inviteOnlyRequest, joinInvite, joinInviteLink, joinWithCode, localStream, muted, networkQuality, paused, pendingInvite, qualityMode, remoteStream, requestInviteShare, requestPeer, requestShare, role, session, sentResolution, setQualityMode, shareCode, startShare, startedAt, stopShare, toggleMute, togglePause, uiState]);

  return <ScreenShareContext.Provider value={value}>{children}</ScreenShareContext.Provider>;
}
