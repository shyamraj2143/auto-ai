package com.autoai.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
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
    private final OkHttpClient socketClient = new OkHttpClient.Builder().retryOnConnectionFailure(true).build();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
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
    private boolean remoteMediaReceived;
    private boolean iceRestartAttempted;
    private boolean peerReadyPending;
    private volatile boolean iceDisconnected;
    private volatile int reconnectAttempts;
    private boolean sessionStarted;
    private boolean muted;
    private boolean cameraEnabled = true;
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
        remoteMediaReceived = false;
        iceRestartAttempted = false;
        peerReadyPending = false;
        iceDisconnected = false;
        reconnectAttempts = 0;
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
    }

    public void removeListener(Listener listener) { listeners.remove(listener); }

    public synchronized void attachRenderers(SurfaceViewRenderer local, SurfaceViewRenderer remote) {
        if (engine != null) engine.attachRenderers(local, remote);
    }

    public synchronized void detachRenderers() { if (engine != null) engine.detachRenderers(); }
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
            JSONObject call = api.getCall(callId);
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
        } catch (NativeCallApi.ApiException auth) {
            fail(auth.status == 401 || auth.status == 403 ? "SIGNALING_AUTH_FAILED" : "SIGNALING_TIMEOUT", auth);
        } catch (Exception error) {
            fail("SIGNALING_TIMEOUT", error);
        }
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
                executor.execute(() -> {
                    try {
                        backendStatus = api.getCall(callId).optString("status", backendStatus);
                        if (isAcceptedStatus(backendStatus)) startMediaAfterAccept();
                        else if (isTerminalStatus(backendStatus)) closeInternal(true, null);
                    } catch (Exception error) { Log.w(TAG, "Authoritative state refresh deferred callId=" + callId, error); }
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                executor.execute(() -> handleSignal(text));
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                if (webSocket != socket) return;
                signalingOpen = false;
                if (!terminal.get()) scheduleReconnect();
            }

            @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) {
                if (webSocket != socket) return;
                signalingOpen = false;
                if (!terminal.get()) scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (!reconnectScheduled.compareAndSet(false, true)) return;
        int attempt = ++reconnectAttempts;
        if (attempt > 8) {
            reconnectScheduled.set(false);
            fail("SIGNALING_TIMEOUT", new IllegalStateException("Signaling reconnect limit reached"));
            return;
        }
        update(ActiveCallStore.State.RECONNECTING, null);
        executor.execute(() -> {
            try {
                Thread.sleep(Math.min(4000L, attempt * 500L));
                reconnectScheduled.set(false);
                if (!terminal.get()) connectSocket(api.websocketUrl());
            } catch (Exception error) {
                reconnectScheduled.set(false);
                fail("SIGNALING_TIMEOUT", error);
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
                peerReadyPending = true;
                if (engine != null) {
                    peerReadyPending = false;
                    engine.createOffer(false);
                }
            } else if ("webrtc.offer".equals(type)) {
                if (engine != null) engine.applyOffer(payload.getString("sdp"));
            } else if ("webrtc.answer".equals(type)) {
                if (engine != null) engine.applyAnswer(payload.getString("sdp"));
            } else if ("webrtc.ice_candidate".equals(type)) {
                if (engine != null) engine.addRemoteCandidate(payload.optString("sdpMid", null), payload.optInt("sdpMLineIndex", 0), payload.optString("candidate", ""));
            } else if ("webrtc.ice_restart".equals(type) && engine != null && !iceRestartAttempted) {
                iceRestartAttempted = true;
                engine.restartIce();
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
                NativeWebRtcEngine created = new NativeWebRtcEngine(context, engineListener);
                created.start("video".equals(callType), iceServers);
                synchronized (this) { engine = created; engine.setMuted(muted); engine.setCameraEnabled(cameraEnabled); }
                if ("outgoing".equals(direction) && peerReadyPending && signalingOpen) {
                    peerReadyPending = false;
                    created.createOffer(false);
                }
                if (signalingOpen && "incoming".equals(direction)) {
                    send("call.peer_ready", callId, new JSONObject()
                        .put("call_type", backendCallType).put("audio_ready", true)
                        .put("video_ready", !"video".equals(backendCallType) || (!audioOnly && cameraEnabled))
                        .put("audio_only", audioOnly)
                        .put("negotiation_id", UUID.randomUUID().toString()));
                }
            } catch (SecurityException permission) {
                fail("video".equals(callType) ? "CAMERA_PERMISSION_DENIED" : "MICROPHONE_PERMISSION_DENIED", permission);
            } catch (Exception error) {
                fail("INTERNAL_CALL_ERROR", error);
            }
        });
    }

    private final NativeWebRtcEngine.Listener engineListener = new NativeWebRtcEngine.Listener() {
        @Override public void onLocalDescription(SessionDescription description) {
            String event = description.type == SessionDescription.Type.OFFER ? "webrtc.offer" : "webrtc.answer";
            send(event, callId, json("type", description.type.canonicalForm(), "sdp", description.description));
            if (description.type == SessionDescription.Type.ANSWER) Log.i(TAG, "ANSWER_SENT callId=" + callId);
        }

        @Override public void onLocalIceCandidate(IceCandidate candidate) {
            send("webrtc.ice_candidate", callId, json("candidate", candidate.sdp,
                "sdpMid", candidate.sdpMid, "sdpMLineIndex", candidate.sdpMLineIndex));
        }

        @Override public void onIceState(PeerConnection.IceConnectionState state) {
            if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) {
                iceDisconnected = false;
                Log.i(TAG, "ICE_CONNECTED callId=" + callId);
            } else if (state == PeerConnection.IceConnectionState.DISCONNECTED) {
                iceDisconnected = true;
                update(ActiveCallStore.State.RECONNECTING, null);
            } else if (state == PeerConnection.IceConnectionState.FAILED) {
                iceDisconnected = true;
                if (!iceRestartAttempted && engine != null) { iceRestartAttempted = true; engine.restartIce(); }
                else fail("ICE_CONNECTION_FAILED", null);
            }
        }

        @Override public void onRemoteMedia(boolean video) {
            if (remoteMediaReceived) return;
            remoteMediaReceived = true;
            update(ActiveCallStore.State.MEDIA_CONNECTED, null);
            AutoAiTelecomBridge.markActive(context, callId);
            send("call.media_ready", callId, json("audio_ready", true, "video_ready", video || "audio".equals(callType)));
            send("call.connected", callId, new JSONObject());
            Log.i(TAG, "REMOTE_MEDIA_RECEIVED callId=" + callId);
            Log.i(TAG, "CALL_CONNECTED callId=" + callId);
            for (Listener listener : listeners) if (video) listener.onRemoteVideoAvailable();
        }

        @Override public void onRemoteDescriptionApplied(SessionDescription.Type type) {
            if (type == SessionDescription.Type.OFFER) Log.i(TAG, "OFFER_APPLIED callId=" + callId);
        }

        @Override public void onFailure(String errorCode, Throwable error) { fail(errorCode, error); }
    };

    private void send(String type, String eventCallId, JSONObject payload) {
        WebSocket current = socket;
        if (current == null || !signalingOpen) return;
        try {
            JSONObject event = new JSONObject().put("schema_version", 1).put("event_id", UUID.randomUUID().toString())
                .put("type", type).put("timestamp", timestamp()).put("payload", payload == null ? new JSONObject() : payload);
            if (eventCallId != null) event.put("call_id", eventCallId);
            current.send(event.toString());
        } catch (org.json.JSONException error) {
            fail("INTERNAL_CALL_ERROR", error);
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
                if (!terminal.get() && iceDisconnected && engine != null && !iceRestartAttempted) {
                    iceRestartAttempted = true;
                    update(ActiveCallStore.State.RECONNECTING, null);
                    engine.restartIce();
                }
            }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {}
        };
        manager.registerDefaultNetworkCallback(networkCallback);
    }

    private synchronized void closeInternal(boolean terminalState, String errorCode) {
        sessionStarted = false;
        signalingOpen = false;
        if (socket != null) socket.close(1000, "call terminal");
        socket = null;
        if (engine != null) engine.close();
        engine = null;
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
