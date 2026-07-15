import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../../contexts/AuthContext";
import type { PublicCallUser } from "../calls/types";
import { screenShareApi, ScreenShareSignaling } from "./screenShareApi";
import { ScreenShareContext, type ScreenShareContextValue } from "./ScreenShareContext";
import type { ScreenShareInvite, ScreenShareRole, ScreenShareSession, ScreenShareSignal, ScreenShareSource, ScreenShareUiState } from "./types";

const RECONNECT_LIMIT = 3;

function sessionIdOf(session: ScreenShareSession | null) {
  return session?.sessionId ?? session?.session_id ?? "";
}

function inviteLinkOf(session: ScreenShareSession | null) {
  return session?.inviteLink ?? session?.invite_link ?? "";
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
    video: { displaySurface, frameRate: { ideal: 24, max: 30 } } as MediaTrackConstraints,
    audio: false,
  };
}

export function ScreenShareProvider({ children }: { children: ReactNode }) {
  const { token, user } = useAuth();
  const [uiState, setUiState] = useState<ScreenShareUiState>("idle");
  const [role, setRole] = useState<ScreenShareRole | null>(null);
  const [session, setSession] = useState<ScreenShareSession | null>(null);
  const [requestPeer, setRequestPeer] = useState<PublicCallUser | null>(null);
  const [pendingInvite, setPendingInvite] = useState<ScreenShareInvite | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const tokenRef = useRef(token);
  const roleRef = useRef<ScreenShareRole | null>(null);
  const sessionRef = useRef<ScreenShareSession | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const eventHandlerRef = useRef<(event: ScreenShareSignal) => void>(() => undefined);
  const createOfferRef = useRef<(iceRestart?: boolean) => Promise<void>>(async () => undefined);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);

  tokenRef.current = token;
  roleRef.current = role;
  sessionRef.current = session;
  localStreamRef.current = localStream;
  remoteStreamRef.current = remoteStream;

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
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  const reset = useCallback((nextState: ScreenShareUiState = "idle") => {
    closePeer();
    stopLocalTracks();
    remoteStreamRef.current = null;
    setRemoteStream(null);
    setSession(null);
    setRole(null);
    setRequestPeer(null);
    setPendingInvite(null);
    setStartedAt(null);
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
        setUiState("active");
      } else if (["disconnected", "failed"].includes(peer.connectionState)) {
        setUiState("reconnecting");
        const id = sessionIdOf(sessionRef.current);
        if (roleRef.current === "sharer" && id && reconnectAttemptsRef.current < RECONNECT_LIMIT) {
          reconnectAttemptsRef.current += 1;
          window.setTimeout(() => void createOfferRef.current(true), 1000 * reconnectAttemptsRef.current);
        } else if (reconnectAttemptsRef.current >= RECONNECT_LIMIT) {
          setUiState("failed");
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
    setRequestPeer(peer);
  }, []);

  const cancelRequest = useCallback(() => setRequestPeer(null), []);

  const startShare = useCallback(async (source: ScreenShareSource) => {
    const currentToken = tokenRef.current;
    const peer = requestPeer;
    if (!currentToken || !peer) return;
    setUiState("preparing");
    setError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(sourceConstraint(source));
      stream.getVideoTracks()[0]?.addEventListener("ended", () => void stopShare());
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMuted(true);
      const created = await screenShareApi.createSession(currentToken, {
        viewer_user_id: peer.id,
        invite_link: true,
        expires_minutes: 60,
      });
      setSession(created);
      setRole("sharer");
      setRequestPeer(null);
      setUiState("waiting");
      await ensureSignaling();
      const id = sessionIdOf(created);
      signaling.send("join-session", id);
      signaling.send("screen-share-started", id);
    } catch (shareError) {
      stopLocalTracks();
      setUiState("failed");
      setError(shareError instanceof Error ? shareError.message : "Screen capture permission was denied.");
    }
  }, [ensureSignaling, requestPeer, signaling, stopLocalTracks, stopShare]);

  const joinBySession = useCallback(async (sessionId: string, inviteToken?: string | null) => {
    const currentToken = tokenRef.current;
    if (!currentToken || !sessionId) return;
    setUiState("connecting");
    setError("");
    try {
      const nextSession = await screenShareApi.getSession(currentToken, sessionId, inviteToken);
      setSession(nextSession);
      setRole("viewer");
      setPendingInvite(null);
      await ensureSignaling();
      signaling.send("join-session", sessionId, inviteToken ? { inviteToken } : {});
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

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) {
      setMuted(true);
      return;
    }
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }, []);

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

  const value = useMemo<ScreenShareContextValue>(() => ({
    uiState,
    role,
    session,
    requestPeer,
    pendingInvite,
    localStream,
    remoteStream,
    error,
    muted,
    paused,
    startedAt,
    requestShare,
    cancelRequest,
    startShare,
    joinInvite,
    joinInviteLink,
    declineInvite,
    stopShare,
    toggleMute,
    togglePause,
    copyInviteLink,
    clearError: () => setError(""),
  }), [cancelRequest, copyInviteLink, declineInvite, error, joinInvite, joinInviteLink, localStream, muted, paused, pendingInvite, remoteStream, requestPeer, requestShare, role, session, startShare, startedAt, stopShare, toggleMute, togglePause, uiState]);

  return <ScreenShareContext.Provider value={value}>{children}</ScreenShareContext.Provider>;
}
