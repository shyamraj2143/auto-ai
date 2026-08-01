package com.autoai.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.IceCandidate;
import org.webrtc.PeerConnection;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceViewRenderer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Process-wide owner of the Android signaling socket, PeerConnection and media tracks. */
public final class NativeCallSessionController {
    public interface Listener {
        void onState(ActiveCallStore.State state, String errorCode);
        default void onRemoteVideoAvailable() {}
    }

    private static final String TAG = "AutoAiNativeCall";
    private static final int MAX_SIGNAL_RECONNECT_ATTEMPTS = 20;
    private static final int MAX_INITIALIZATION_ATTEMPTS = 12;
    private static final int MAX_ICE_RESTART_ATTEMPTS = 2;
    private static final long INITIAL_MEDIA_TIMEOUT_MS = 15_000L;
    private static final long ICE_DISCONNECT_GRACE_MS = 4_000L;
    private static final long ICE_RECOVERY_TIMEOUT_MS = 12_000L;
    private static volatile NativeCallSessionController instance;

    public static NativeCallSessionController get(Context context) {
        if (instance == null) synchronized (NativeCallSessionController.class) {
            if (instance == null) instance = new NativeCallSessionController(context.getApplicationContext());
        }
        return instance;
    }

    private final Context context;
    private final NativeCallApi api;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final OkHttpClient socketClient = new OkHttpClient.Builder()
        .retryOnConnectionFailure(true)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final NativeMediaReadiness mediaReadiness = new NativeMediaReadiness();
    private final AtomicBoolean mediaStarting = new AtomicBoolean(false);
    private final AtomicBoolean terminal = new AtomicBoolean(false);
    private final AtomicBoolean reconnectScheduled = new AtomicBoolean(false);
    private volatile NativeWebRtcEngine engine;
    private volatile WebSocket socket;
    private String callId;
    private String callType;
    private String peerName;
    private String direction;
    private String backendStatus;
    private String backendCallType;
    private boolean audioOnly;
    private boolean signalingOpen;
    private boolean mediaConnectedSignaled;
    private boolean remoteVideoNotified;
    private boolean mediaReconnecting;
    private boolean iceRecoveryInFlight;
    private boolean iceRestartPending;
    private int iceRestartAttempts;
    private long mediaWatchdogGeneration;
    private boolean peerReadyPending;
    private boolean initialOfferStarted;
    private volatile boolean iceDisconnected;
    private volatile int reconnectAttempts;
    private volatile int initializationAttempts;
    private boolean sessionStarted;
    private boolean muted;
    private boolean cameraEnabled = true;
    private boolean peerReadySent;
    private String pendingOfferSdp;
    private String pendingAnswerSdp;
    private final List<PendingRemoteCandidate> pendingRemoteCandidates = new ArrayList<>();
    private final List<String> pendingOutboundSignals = new ArrayList<>();
    private SurfaceViewRenderer localRenderer;
    private SurfaceViewRenderer remoteRenderer;
    private ConnectivityManager.NetworkCallback networkCallback;

    private NativeCallSessionController(Context context) {
        this.context = context;
        api = new NativeCallApi(context);
    }

    public synchronized void start(String requestedCallId, String requestedCallType, String requestedPeerName) {
        if (requestedCallId == null || requestedCallId.trim().isEmpty()) throw new IllegalArgumentException("call_id required");
        if (callId != null && !callId.equals(requestedCallId) && !terminal.get()) throw new IllegalStateException("Another native call is active.");
        if (requestedCallId.trim().equals(callId) && sessionStarted && !terminal.get()) return;
        callId = requestedCallId.trim();
        callType = "video".equals(requestedCallType) ? "video" : "audio";
        peerName = clean(requestedPeerName, "Auto-AI user");
        terminal.set(false);
        mediaStarting.set(false);
        reconnectScheduled.set(false);
        mediaReadiness.reset();
        mediaConnectedSignaled = false;
        remoteVideoNotified = false;
        mediaReconnecting = false;
        iceRecoveryInFlight = false;
        iceRestartPending = false;
        iceRestartAttempts = 0;
        cancelMediaWatchdog();
        peerReadyPending = false;
        initialOfferStarted = false;
        peerReadySent = false;
        pendingOfferSdp = null;
        pendingAnswerSdp = null;
        pendingRemoteCandidates.clear();
        iceDisconnected = false;
        reconnectAttempts = 0;
        initializationAttempts = 0;
        pendingOutboundSignals.clear();
        sessionStarted = true;
        executor.execute(this::initializeSession);
    }

    public synchronized boolean owns(String requestedCallId) {
        return requestedCallId != null && requestedCallId.equals(callId) && !terminal.get();
    }

    public void addListener(Listener listener) {
        if (listener != null && !listeners.contains(listener)) listeners.add(listener);
        ActiveCallStore.Snapshot snapshot = ActiveCallStore.get(context, callId);
        if (listener != null && snapshot != null) listener.onState(snapshot.state, snapshot.lastErrorCode);
        if (listener != null && mediaReadiness.hasRemoteVideoTrack()) listener.onRemoteVideoAvailable();
    }

    public void removeListener(Listener listener) { listeners.remove(listener); }

    public synchronized void attachRenderers(SurfaceViewRenderer local, SurfaceViewRenderer remote) {
        localRenderer = local;
        remoteRenderer = remote;
        if (engine != null) engine.attachRenderers(local, remote);
    }

    public synchronized void detachRenderers() {
        if (engine != null) engine.detachRenderers();
        localRenderer = null;
        remoteRenderer = null;
    }
    public synchronized void setMuted(boolean value) { muted = value; if (engine != null) engine.setMuted(value); }
    public synchronized boolean isMuted() { return muted; }
    public synchronized void setCameraEnabled(boolean value) { cameraEnabled = value; if (engine != null) engine.setCameraEnabled(value); }
    public synchronized boolean isCameraEnabled() { return cameraEnabled; }
    public synchronized void switchCamera() { if (engine != null) engine.switchCamera(); }

    public void end(String reason) {
        final String endingCallId = callId;
        if (endingCallId == null || !terminal.compareAndSet(false, true)) return;
        executor.execute(() -> {
            try { api.end(endingCallId, reason == null ? "user_hangup" : reason); }
            catch (Exception error) { Log.w(TAG, "Backend end deferred callId=" + endingCallId, error); }
            closeInternal(true, null);
        });
    }

    void terminateAfterBackendAction(String requestedCallId) {
        if (!owns(requestedCallId)) return;
        if (!terminal.compareAndSet(false, true)) return;
        executor.execute(() -> closeInternal(true, null));
    }

    public void fail(String errorCode, Throwable cause) {
        final String failedCallId = callId;
        if (failedCallId == null || !terminal.compareAndSet(false, true)) return;
        Log.e(TAG, "Native call failed callId=" + failedCallId + " code=" + errorCode, cause);
        executor.execute(() -> {
            try { api.fail(failedCallId, errorCode); }
            catch (Exception reportError) { Log.e(TAG, "Failure synchronization failed callId=" + failedCallId, reportError); }
            closeInternal(true, errorCode);
        });
    }

    private void initializeSession() {
        try {
            if (!CallFailureMessages.isOnline(context)) {
                fail("NETWORK_LOST", new IllegalStateException("No validated internet connection"));
                return;
            }
            JSONObject call = api.getCall(callId);
            initializationAttempts = 0;
            backendStatus = call.optString("status", "");
            direction = call.optString("direction", "incoming");
            backendCallType = call.optString("call_type", callType);
            audioOnly = "video".equals(backendCallType) && "audio".equals(callType);
            if (!audioOnly) callType = backendCallType;
            JSONObject peer = call.optJSONObject("peer");
            if (peer != null) peerName = clean(peer.optString("display_name", peerName), peerName);
            if (isTerminalStatus(backendStatus)) {
                fail("CALL_STATE_CONFLICT", new IllegalStateException("Call already " + backendStatus));
                return;
            }
            registerNetworkCallback();
            update(ActiveCallStore.State.SIGNALING_CONNECTING, null);
            connectSocket(api.websocketUrl());
            if (isAcceptedStatus(backendStatus)) startMediaAfterAccept();
        } catch (NativeCallApi.ApiException error) {
            if (error.status == 401 || error.status == 403) fail("SIGNALING_AUTH_FAILED", error);
            else scheduleInitializationRetry(error);
        } catch (Exception error) {
            scheduleInitializationRetry(error);
        }
    }

    private void scheduleInitializationRetry(Throwable cause) {
        if (terminal.get()) return;
        int attempt = ++initializationAttempts;
        if (attempt > MAX_INITIALIZATION_ATTEMPTS) {
            fail(CallFailureMessages.isOnline(context) ? "SIGNALING_TIMEOUT" : "NETWORK_LOST", cause);
            return;
        }
        update(ActiveCallStore.State.RECONNECTING, null);
        long delay = Math.min(4000L, 400L * attempt);
        Log.w(TAG, "SIGNALING_INITIALIZATION_RETRY callId=" + callId + " attempt=" + attempt + " delayMs=" + delay, cause);
        executor.execute(() -> {
            try {
                Thread.sleep(delay);
                if (!terminal.get()) initializeSession();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                fail("SIGNALING_TIMEOUT", interrupted);
            }
        });
    }

    private void connectSocket(String url) {
        Request request = new Request.Builder().url(url).build();
        socket = socketClient.newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                if (webSocket != socket || terminal.get()) return;
                signalingOpen = true;
                reconnectAttempts = 0;
                reconnectScheduled.set(false);
                update(ActiveCallStore.State.SIGNALING_CONNECTED, null);
                Log.i(TAG, "SIGNALING_CONNECTED callId=" + callId);
                send("presence.ready", null, json("state", "background"));
                flushPendingOutboundSignals();
                executor.execute(() -> {
                    try {                        backendStatus = api.getCall(callId).optString("status", backendStatus);
                            if (isAcceptedStatus(backendStatus)) {
                                startMediaAfterAccept();
                                announcePeerReadyIfPossible();
                            } else if (isTerminalStatus(backendStatus)) closeInternal(true, null);
                    } catch (Exception error) { Log.w(TAG, "Authoritative state refresh deferred callId=" + callId, error); }
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                executor.execute(() -> handleSignal(text));
            }            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                    if (webSocket != socket) return;
                    signalingOpen = false;
                    peerReadySent = false;
                    if (!terminal.get()) scheduleReconnect();
                }

                @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                    if (webSocket != socket) return;
                    signalingOpen = false;
                    peerReadySent = false;
                    if (!terminal.get()) scheduleReconnect();
                }
        });
    }

    private void scheduleReconnect() {
        if (!reconnectScheduled.compareAndSet(false, true)) return;
        int attempt = ++reconnectAttempts;
        if (attempt > MAX_SIGNAL_RECONNECT_ATTEMPTS) {
            reconnectScheduled.set(false);
            String failure = CallFailureMessages.isOnline(context) ? "SIGNALING_TIMEOUT" : "NETWORK_LOST";
            fail(failure, new IllegalStateException("Signaling reconnect limit reached"));
            return;
        }
        update(ActiveCallStore.State.RECONNECTING, null);
        executor.execute(() -> {
            try {
                Thread.sleep(Math.min(3000L, attempt * 350L));
                reconnectScheduled.set(false);
                if (!terminal.get()) connectSocket(api.websocketUrl());
            } catch (Exception error) {
                reconnectScheduled.set(false);
                if (!terminal.get()) scheduleReconnect();
            }
        });
    }

    private void handleSignal(String raw) {
        try {
            JSONObject event = new JSONObject(raw);
            String eventCallId = event.optString("call_id", "");
            String type = event.optString("type", "");
            if (!eventCallId.isEmpty() && !eventCallId.equals(callId)) return;
            JSONObject payload = event.optJSONObject("payload");
            if (payload == null) payload = new JSONObject();
            if ("call.accepted".equals(type) || "call.active".equals(type)) {
                backendStatus = "accepted";
                startMediaAfterAccept();
            } else if ("call.peer_ready".equals(type) && "outgoing".equals(direction)) {
                if (!initialOfferStarted) peerReadyPending = true;
                createInitialOfferIfPossible();
            } else if ("webrtc.offer".equals(type)) {
                String sdp = payload.getString("sdp");
                if (engine != null) engine.applyOffer(sdp); else pendingOfferSdp = sdp;
            } else if ("webrtc.answer".equals(type)) {
                String sdp = payload.getString("sdp");
                if (engine != null) engine.applyAnswer(sdp); else pendingAnswerSdp = sdp;
            } else if ("webrtc.ice_candidate".equals(type)) {
                PendingRemoteCandidate candidate = new PendingRemoteCandidate(
                    payload.optString("sdpMid", null), payload.optInt("sdpMLineIndex", 0), payload.optString("candidate", ""));
                if (engine != null) engine.addRemoteCandidate(candidate.mid, candidate.lineIndex, candidate.candidate);
                else pendingRemoteCandidates.add(candidate);
            } else if ("webrtc.ice_restart".equals(type)) {
                handleRemoteIceRestartRequest();
            } else if (type.startsWith("call.") && isTerminalSignal(type)) {
                terminal.set(true);
                closeInternal(true, null);
            }
        } catch (Exception error) {
            fail("INTERNAL_CALL_ERROR", error);
        }
    }

    private void startMediaAfterAccept() {
        if (!mediaStarting.compareAndSet(false, true) || terminal.get()) return;
        executor.execute(() -> {
            try {
                update(ActiveCallStore.State.MEDIA_CONNECTING, null);
                List<PeerConnection.IceServer> iceServers = parseIceServers(api.turnCredentials());
                if (iceServers.isEmpty()) throw new NativeCallApi.ApiException(503, "No usable call relay configuration.");
                NativeWebRtcEngine created = new NativeWebRtcEngine(context, engineListener);
                created.start("video".equals(callType), iceServers);
                SurfaceViewRenderer pendingLocal;
                SurfaceViewRenderer pendingRemote;
                synchronized (this) {
                    engine = created;
                    engine.setMuted(muted);
                    engine.setCameraEnabled(cameraEnabled);
                    pendingLocal = localRenderer;
                    pendingRemote = remoteRenderer;
                }
                if (pendingLocal != null || pendingRemote != null) {
                    mainHandler.post(() -> {
                        synchronized (NativeCallSessionController.this) {
                            if (engine != created || localRenderer != pendingLocal || remoteRenderer != pendingRemote) return;
                            try { created.attachRenderers(pendingLocal, pendingRemote); }
                            catch (RuntimeException error) { Log.w(TAG, "Video renderer attach deferred callId=" + callId, error); }
                        }
                    });
                }
                flushPendingRemoteSignals(created);
                announcePeerReadyIfPossible();
                if (iceRestartPending && "outgoing".equals(direction)) {
                    iceRestartPending = false;
                    iceRecoveryInFlight = true;
                    restartAsOfferer("queued_remote_request");
                } else {
                    armMediaWatchdog(INITIAL_MEDIA_TIMEOUT_MS);
                }
            } catch (SecurityException permission) {
                fail("video".equals(callType) ? "CAMERA_PERMISSION_DENIED" : "MICROPHONE_PERMISSION_DENIED", permission);
            } catch (NativeCallApi.ApiException relayError) {
                fail(relayError.status == 401 || relayError.status == 403 ? "TURN_AUTH_FAILED" : "TURN_UNREACHABLE", relayError);
            } catch (Exception error) {
                fail("INTERNAL_CALL_ERROR", error);
            }
        });
    }

    private synchronized void announcePeerReadyIfPossible() {
        NativeWebRtcEngine current = engine;
        if (!signalingOpen || current == null || terminal.get()) return;
        if ("outgoing".equals(direction)) {
            createInitialOfferIfPossible();
            return;
        }
        if ("incoming".equals(direction) && !peerReadySent) {
            peerReadySent = true;
            send("call.peer_ready", callId, json("call_type", backendCallType, "audio_ready", true, "video_ready", !"video".equals(backendCallType) || (!audioOnly && cameraEnabled), "audio_only", audioOnly, "negotiation_id", UUID.randomUUID().toString()));
            Log.i(TAG, "PEER_READY_SENT callId=" + callId);
        }
    }

    private synchronized void createInitialOfferIfPossible() {
        NativeWebRtcEngine current = engine;
        if (!peerReadyPending || initialOfferStarted || current == null || terminal.get()) return;
        peerReadyPending = false;
        initialOfferStarted = true;
        current.createOffer(false);
    }

    private synchronized void flushPendingRemoteSignals(NativeWebRtcEngine current) {
        if ("incoming".equals(direction) && pendingOfferSdp != null) {
            current.applyOffer(pendingOfferSdp);
            pendingOfferSdp = null;
        } else if ("outgoing".equals(direction) && pendingAnswerSdp != null) {
            current.applyAnswer(pendingAnswerSdp);
            pendingAnswerSdp = null;
        }
        for (PendingRemoteCandidate candidate : pendingRemoteCandidates) {
            current.addRemoteCandidate(candidate.mid, candidate.lineIndex, candidate.candidate);
        }
        pendingRemoteCandidates.clear();
    }

    private final NativeWebRtcEngine.Listener engineListener = new NativeWebRtcEngine.Listener() {
        @Override public void onLocalDescription(SessionDescription description) {
            executor.execute(() -> {
                String event = description.type == SessionDescription.Type.OFFER ? "webrtc.offer" : "webrtc.answer";
                send(event, callId, json("type", description.type.canonicalForm(), "sdp", description.description));
                if (description.type == SessionDescription.Type.ANSWER) Log.i(TAG, "ANSWER_SENT callId=" + callId);
            });
        }

        @Override public void onLocalIceCandidate(IceCandidate candidate) {
            executor.execute(() -> send("webrtc.ice_candidate", callId, json("candidate", candidate.sdp,
                "sdpMid", candidate.sdpMid, "sdpMLineIndex", candidate.sdpMLineIndex)));
        }

        @Override public void onIceState(PeerConnection.IceConnectionState state) {
            executor.execute(() -> handleIceState(state));
        }

        @Override public void onPeerConnectionState(PeerConnection.PeerConnectionState state) {
            executor.execute(() -> handlePeerConnectionState(state));
        }

        @Override public void onRemoteTrack(boolean video) {
            executor.execute(() -> handleRemoteTrack(video));
        }

        @Override public void onFirstRemoteVideoFrame() {
            executor.execute(NativeCallSessionController.this::handleFirstRemoteVideoFrame);
        }

        @Override public void onRemoteDescriptionApplied(SessionDescription.Type type) {
            if (type == SessionDescription.Type.OFFER) Log.i(TAG, "OFFER_APPLIED callId=" + callId);
        }

        @Override public void onFailure(String errorCode, Throwable error) {
            executor.execute(() -> fail(errorCode, error));
        }
    };

    private void handleIceState(PeerConnection.IceConnectionState state) {
        if (terminal.get()) return;
        if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) {
            mediaReadiness.setIceConnected(true);
            iceDisconnected = false;
            Log.i(TAG, "ICE_CONNECTED callId=" + callId);
            maybeMarkMediaConnected();
        } else if (state == PeerConnection.IceConnectionState.DISCONNECTED) {
            mediaReadiness.setIceConnected(false);
            mediaReadiness.setPeerConnected(false);
            iceDisconnected = true;
            beginMediaReconnect(ICE_DISCONNECT_GRACE_MS);
        } else if (state == PeerConnection.IceConnectionState.FAILED) {
            mediaReadiness.setIceConnected(false);
            mediaReadiness.setPeerConnected(false);
            iceDisconnected = true;
            recoverMedia("ice_failed");
        } else if (state == PeerConnection.IceConnectionState.CLOSED) {
            mediaReadiness.setIceConnected(false);
            mediaReadiness.setPeerConnected(false);
        }
    }

    private void handlePeerConnectionState(PeerConnection.PeerConnectionState state) {
        if (terminal.get()) return;
        if (state == PeerConnection.PeerConnectionState.CONNECTED) {
            mediaReadiness.setPeerConnected(true);
            iceDisconnected = false;
            Log.i(TAG, "PEER_CONNECTION_CONNECTED callId=" + callId);
            maybeMarkMediaConnected();
        } else if (state == PeerConnection.PeerConnectionState.DISCONNECTED) {
            mediaReadiness.setPeerConnected(false);
            mediaReadiness.setIceConnected(false);
            iceDisconnected = true;
            beginMediaReconnect(ICE_DISCONNECT_GRACE_MS);
        } else if (state == PeerConnection.PeerConnectionState.FAILED) {
            mediaReadiness.setPeerConnected(false);
            mediaReadiness.setIceConnected(false);
            iceDisconnected = true;
            recoverMedia("peer_connection_failed");
        } else if (state == PeerConnection.PeerConnectionState.CLOSED) {
            mediaReadiness.setPeerConnected(false);
            mediaReadiness.setIceConnected(false);
        }
    }

    private void handleRemoteTrack(boolean video) {
        if (terminal.get()) return;
        mediaReadiness.markRemoteTrack(video);
        if (video) notifyRemoteVideoAvailable();
        maybeMarkMediaConnected();
    }

    private void handleFirstRemoteVideoFrame() {
        if (terminal.get()) return;
        mediaReadiness.markFirstRemoteVideoFrame();
        notifyRemoteVideoAvailable();
        if (mediaConnectedSignaled) {
            send("call.media_ready", callId, json("audio_ready", true, "video_ready", true));
        }
        Log.i(TAG, "REMOTE_VIDEO_FIRST_FRAME callId=" + callId);
    }

    private void notifyRemoteVideoAvailable() {
        if (remoteVideoNotified) return;
        remoteVideoNotified = true;
        for (Listener listener : listeners) listener.onRemoteVideoAvailable();
    }

    private void maybeMarkMediaConnected() {
        if (terminal.get() || !mediaReadiness.isMediaConnected()) return;
        boolean recovered = mediaReconnecting;
        mediaReconnecting = false;
        iceRecoveryInFlight = false;
        iceDisconnected = false;
        iceRestartAttempts = 0;
        cancelMediaWatchdog();
        if (!mediaConnectedSignaled) {
            mediaConnectedSignaled = true;
            update(ActiveCallStore.State.MEDIA_CONNECTED, null);
            send("call.media_ready", callId, json("audio_ready", true,
                "video_ready", "audio".equals(callType) || mediaReadiness.hasFirstRemoteVideoFrame()));
            send("call.connected", callId, new JSONObject());
            Log.i(TAG, "REMOTE_MEDIA_RECEIVED callId=" + callId + " transport_connected=true");
            Log.i(TAG, "CALL_CONNECTED callId=" + callId);
        } else if (recovered) {
            update(ActiveCallStore.State.MEDIA_CONNECTED, null);
            send("call.media_ready", callId, json("audio_ready", true,
                "video_ready", "audio".equals(callType) || mediaReadiness.hasFirstRemoteVideoFrame()));
            Log.i(TAG, "MEDIA_RECOVERED callId=" + callId);
        }
    }

    private void beginMediaReconnect(long timeoutMs) {
        if (terminal.get()) return;
        if (!mediaReconnecting) {
            mediaReconnecting = true;
            update(ActiveCallStore.State.RECONNECTING, null);
        }
        if (!iceRecoveryInFlight) armMediaWatchdog(timeoutMs);
    }

    private void recoverMedia(String reason) {
        if (terminal.get() || mediaReadiness.isMediaConnected()) return;
        if (iceRecoveryInFlight) return;
        if (engine == null) {
            fail("ICE_CONNECTION_FAILED", new IllegalStateException("Media engine unavailable during recovery."));
            return;
        }
        if (iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) {
            fail("ICE_CONNECTION_FAILED", new IllegalStateException("Media recovery exhausted: " + reason));
            return;
        }
        iceRestartAttempts++;
        iceRecoveryInFlight = true;
        mediaReconnecting = true;
        update(ActiveCallStore.State.RECONNECTING, null);
        Log.w(TAG, "ICE_RECOVERY callId=" + callId + " attempt=" + iceRestartAttempts + " reason=" + reason);
        if ("outgoing".equals(direction)) restartAsOfferer(reason);
        else send("webrtc.ice_restart", callId, json("reason", reason));
        armMediaWatchdog(ICE_RECOVERY_TIMEOUT_MS);
    }

    private void handleRemoteIceRestartRequest() {
        if (terminal.get()) return;
        if (!"outgoing".equals(direction)) {
            Log.d(TAG, "Ignoring non-offerer ICE restart request callId=" + callId);
            return;
        }
        if (engine == null) {
            iceRestartPending = true;
            return;
        }
        if (iceRecoveryInFlight) return;
        iceRecoveryInFlight = true;
        restartAsOfferer("remote_request");
    }

    private void restartAsOfferer(String reason) {
        NativeWebRtcEngine current = engine;
        if (terminal.get() || current == null) return;
        initialOfferStarted = true;
        mediaReconnecting = true;
        update(ActiveCallStore.State.RECONNECTING, null);
        Log.i(TAG, "ICE_RESTART_OFFER callId=" + callId + " reason=" + reason);
        current.restartIce();
        armMediaWatchdog(ICE_RECOVERY_TIMEOUT_MS);
    }

    private synchronized void armMediaWatchdog(long delayMs) {
        final long generation = ++mediaWatchdogGeneration;
        mainHandler.postDelayed(() -> executor.execute(() -> {
            synchronized (NativeCallSessionController.this) {
                if (generation != mediaWatchdogGeneration) return;
            }
            iceRecoveryInFlight = false;
            recoverMedia("media_timeout");
        }), delayMs);
    }

    private synchronized void cancelMediaWatchdog() { mediaWatchdogGeneration++; }

    private void send(String type, String eventCallId, JSONObject payload) {
        try {
            JSONObject event = new JSONObject().put("schema_version", 1).put("event_id", UUID.randomUUID().toString())
                .put("type", type).put("timestamp", timestamp()).put("payload", payload == null ? new JSONObject() : payload);
            if (eventCallId != null) event.put("call_id", eventCallId);
            String encoded = event.toString();
            WebSocket current = socket;
            if (current == null || !signalingOpen || !current.send(encoded)) {
                queueOutboundSignal(encoded);
                if (!terminal.get()) scheduleReconnect();
            }
        } catch (org.json.JSONException error) {
            fail("INTERNAL_CALL_ERROR", error);
        }
    }

    private synchronized void queueOutboundSignal(String encoded) {
        if (pendingOutboundSignals.size() >= 256) pendingOutboundSignals.remove(0);
        pendingOutboundSignals.add(encoded);
    }

    private synchronized void flushPendingOutboundSignals() {
        WebSocket current = socket;
        if (current == null || !signalingOpen || pendingOutboundSignals.isEmpty()) return;
        List<String> queued = new ArrayList<>(pendingOutboundSignals);
        pendingOutboundSignals.clear();
        for (String encoded : queued) {
            if (!current.send(encoded)) {
                queueOutboundSignal(encoded);
                break;
            }
        }
    }

    private List<PeerConnection.IceServer> parseIceServers(JSONObject response) {
        JSONArray values = response.optJSONArray("iceServers");
        if (values == null) values = response.optJSONArray("ice_servers");
        if (values == null) return Collections.emptyList();
        List<PeerConnection.IceServer> result = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            if (value == null) continue;
            List<String> urls = new ArrayList<>();
            Object rawUrls = value.opt("urls");
            if (rawUrls instanceof JSONArray) {
                JSONArray array = (JSONArray) rawUrls;
                for (int i = 0; i < array.length(); i++) if (!array.optString(i).isEmpty()) urls.add(array.optString(i));
            } else if (rawUrls instanceof String) urls.add((String) rawUrls);
            if (urls.isEmpty()) continue;
            result.add(PeerConnection.IceServer.builder(urls)
                .setUsername(value.optString("username", ""))
                .setPassword(value.optString("credential", "")).createIceServer());
        }
        return result;
    }

    private void registerNetworkCallback() {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                if (!terminal.get() && !signalingOpen) scheduleReconnect();
                if (!terminal.get() && iceDisconnected) {
                    executor.execute(() -> recoverMedia("network_available"));
                }
            }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {}
        };
        manager.registerDefaultNetworkCallback(networkCallback);
    }

    private synchronized void closeInternal(boolean terminalState, String errorCode) {
        cancelMediaWatchdog();
        sessionStarted = false;
        signalingOpen = false;
        if (socket != null) socket.close(1000, "call terminal");
        socket = null;
        if (engine != null) engine.close();
        engine = null;
        pendingOfferSdp = null;
        pendingAnswerSdp = null;
        pendingRemoteCandidates.clear();
        if (terminalState) pendingOutboundSignals.clear();
        peerReadySent = false;
        initialOfferStarted = false;
        mediaReadiness.reset();
        mediaConnectedSignaled = false;
        remoteVideoNotified = false;
        mediaReconnecting = false;
        iceRecoveryInFlight = false;
        iceRestartPending = false;
        iceRestartAttempts = 0;
        iceDisconnected = false;
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager != null && networkCallback != null) try { manager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        networkCallback = null;
        if (terminalState) {
            if (errorCode == null) ActiveCallStore.update(context, callId, ActiveCallStore.State.TERMINAL);
            else ActiveCallStore.fail(context, callId, errorCode);
            AutoAiCallsPlugin.clearActiveCall(context, callId);
            CallNotificationManager.cancelAllForTerminalCall(context, callId);
        }
        notifyState(ActiveCallStore.State.TERMINAL, errorCode);
    }

    private void update(ActiveCallStore.State state, String errorCode) {
        ActiveCallStore.update(context, callId, state);
        notifyState(state, errorCode);
    }

    private void notifyState(ActiveCallStore.State state, String errorCode) {
        for (Listener listener : listeners) listener.onState(state, errorCode);
        context.sendBroadcast(new android.content.Intent("com.autoai.app.call.NATIVE_STATE").setPackage(context.getPackageName())
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId).putExtra("state", state.name()).putExtra("error_code", errorCode));
    }

    private static final class PendingRemoteCandidate {
        final String mid;
        final int lineIndex;
        final String candidate;

        PendingRemoteCandidate(String mid, int lineIndex, String candidate) {
            this.mid = mid;
            this.lineIndex = lineIndex;
            this.candidate = candidate;
        }
    }

    private static boolean isAcceptedStatus(String status) { return "accepted".equals(status) || "connecting".equals(status) || "active".equals(status); }
    private static boolean isTerminalStatus(String status) { return "ended".equals(status) || "failed".equals(status) || "cancelled".equals(status) || "rejected".equals(status) || "missed".equals(status); }
    private static boolean isTerminalSignal(String type) { return "call.ended".equals(type) || "call.failed".equals(type) || "call.cancelled".equals(type) || "call.rejected".equals(type) || "call.missed".equals(type); }
    private static String clean(String value, String fallback) { return value == null || value.trim().isEmpty() ? fallback : value.trim(); }
    private static String timestamp() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }
    private static JSONObject json(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int index = 0; index + 1 < pairs.length; index += 2) result.put(String.valueOf(pairs[index]), pairs[index + 1]);
            return result;
        } catch (org.json.JSONException error) {
            throw new IllegalArgumentException("Unable to encode native call event.", error);
        }
    }
}
