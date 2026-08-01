package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Durable single-call state. Data survives Activities, WebView and service recreation. */
public final class ActiveCallStore {
    public enum State {
        INCOMING_PRESENTED, ACCEPT_REQUESTED, ACCEPT_COMMITTED, SERVICE_STARTING,
        SERVICE_READY, ACTIVE_UI_STARTING, ACTIVE_UI_READY, SIGNALING_CONNECTING,
        SIGNALING_CONNECTED, MEDIA_CONNECTING, MEDIA_CONNECTED, RECONNECTING, TERMINAL
    }

    public static final class Snapshot {
        public final String callId;
        public final String callType;
        public final String action;
        public final String peerId;
        public final String peerName;
        public final String peerAvatar;
        public final String actionToken;
        public final long revision;
        public final long acceptedAt;
        public final long expiresAt;
        public final State state;
        public final String serviceState;
        public final String uiState;
        public final String mediaState;
        public final String lastErrorCode;

        Snapshot(SharedPreferences prefs) {
            callId = prefs.getString("call_id", null);
            callType = prefs.getString("call_type", "audio");
            action = prefs.getString("action", "resume_call");
            peerId = prefs.getString("peer_id", null);
            peerName = prefs.getString("peer_name", "Auto-AI user");
            peerAvatar = prefs.getString("peer_avatar", null);
            actionToken = prefs.getString("action_token", null);
            revision = prefs.getLong("revision", 0L);
            acceptedAt = prefs.getLong("accepted_at", 0L);
            expiresAt = prefs.getLong("expires_at", 0L);
            state = parseState(prefs.getString("state", null));
            serviceState = prefs.getString("service_state", "idle");
            uiState = prefs.getString("ui_state", "idle");
            mediaState = prefs.getString("media_state", "idle");
            lastErrorCode = prefs.getString("last_error_code", null);
        }

        public boolean isUsable() {
            return callId != null && state != null && state != State.TERMINAL
                && (expiresAt <= 0L || expiresAt > System.currentTimeMillis() || acceptedAt > 0L);
        }
    }

    private static final String PREFS = "auto_ai_native_active_call";

    private ActiveCallStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized void presentIncoming(Context context, String callId, String callType,
                                                    String peerId, String peerName, String peerAvatar,
                                                    String actionToken, long revision, long expiresAt) {
        Snapshot existing = get(context);
        if (existing != null && callId.equals(existing.callId) && existing.state != State.TERMINAL) return;
        prefs(context).edit().clear()
            .putString("call_id", clean(callId))
            .putString("call_type", "video".equals(callType) ? "video" : "audio")
            .putString("action", "resume_call")
            .putString("peer_id", clean(peerId))
            .putString("peer_name", clean(peerName) == null ? "Auto-AI user" : clean(peerName))
            .putString("peer_avatar", clean(peerAvatar))
            .putString("action_token", clean(actionToken))
            .putLong("revision", revision)
            .putLong("expires_at", expiresAt)
            .putString("state", State.INCOMING_PRESENTED.name())
            .putString("service_state", "idle")
            .putString("ui_state", "incoming")
            .putString("media_state", "idle")
            .commit();
    }

    public static synchronized void startOutgoing(Context context, String callId, String callType, String peerName) {
        Snapshot existing = get(context);
        if (existing != null && callId.equals(existing.callId) && existing.state != State.TERMINAL) return;
        prefs(context).edit().clear()
            .putString("call_id", clean(callId))
            .putString("call_type", "video".equals(callType) ? "video" : "audio")
            .putString("action", "resume_call")
            .putString("peer_name", clean(peerName) == null ? "Auto-AI user" : clean(peerName))
            .putLong("expires_at", System.currentTimeMillis() + 86_400_000L)
            .putString("state", State.SERVICE_STARTING.name())
            .putString("service_state", "starting")
            .putString("ui_state", "idle")
            .putString("media_state", "ringing")
            .commit();
    }

    public static synchronized boolean beginAccept(Context context, String callId, String callType,
                                                   String peerName, String actionToken, long expiresAt,
                                                   long revision) {
        Snapshot current = get(context);
        if (current == null || !callId.equals(current.callId)) {
            presentIncoming(context, callId, callType, null, peerName, null, actionToken, revision, expiresAt);
            current = get(context);
        }
        if (current.state != State.INCOMING_PRESENTED) return false;
        return prefs(context).edit()
            .putString("action", "resume_call")
            .putString("call_type", "video".equals(callType) ? "video" : "audio")
            .putString("state", State.ACCEPT_REQUESTED.name())
            .commit();
    }

    public static synchronized void commitAccept(Context context, String callId, long revision) {
        if (!matches(context, callId)) return;
        prefs(context).edit()
            .putLong("accepted_at", System.currentTimeMillis())
            .putLong("revision", Math.max(revision, get(context).revision))
            .putString("state", State.ACCEPT_COMMITTED.name())
            .putString("last_error_code", null)
            .commit();
    }

    public static synchronized void update(Context context, String callId, State state) {
        if (!matches(context, callId)) return;
        SharedPreferences.Editor editor = prefs(context).edit().putString("state", state.name());
        switch (state) {
            case SERVICE_STARTING: editor.putString("service_state", "starting"); break;
            case SERVICE_READY: editor.putString("service_state", "ready"); break;
            case ACTIVE_UI_STARTING: editor.putString("ui_state", "starting"); break;
            case ACTIVE_UI_READY: editor.putString("ui_state", "ready"); break;
            case SIGNALING_CONNECTING: editor.putString("media_state", "signaling"); break;
            case SIGNALING_CONNECTED: editor.putString("media_state", "signaling_connected"); break;
            case MEDIA_CONNECTING: editor.putString("media_state", "connecting"); break;
            case MEDIA_CONNECTED: editor.putString("media_state", "connected"); break;
            case RECONNECTING: editor.putString("media_state", "reconnecting"); break;
            case TERMINAL:
                editor.putString("service_state", "stopped").putString("ui_state", "closed").putString("media_state", "terminal");
                break;
            default: break;
        }
        editor.commit();
    }

    public static synchronized void markUiReady(Context context, String callId) {
        if (!matches(context, callId)) return;
        Snapshot current = get(context);
        SharedPreferences.Editor editor = prefs(context).edit().putString("ui_state", "ready");
        if (current.state == null || current.state.ordinal() < State.ACTIVE_UI_READY.ordinal()) {
            editor.putString("state", State.ACTIVE_UI_READY.name());
        }
        editor.commit();
    }

    public static synchronized void fail(Context context, String callId, String errorCode) {
        if (!matches(context, callId)) return;
        prefs(context).edit().putString("last_error_code", clean(errorCode)).putString("state", State.TERMINAL.name())
            .putString("service_state", "failed").putString("media_state", "failed").commit();
    }

    public static Snapshot get(Context context) {
        Snapshot snapshot = new Snapshot(prefs(context));
        return snapshot.callId == null ? null : snapshot;
    }

    public static Snapshot get(Context context, String callId) {
        Snapshot snapshot = get(context);
        return snapshot != null && callId != null && callId.equals(snapshot.callId) ? snapshot : null;
    }

    public static synchronized void clearTerminal(Context context, String callId) {
        Snapshot snapshot = get(context);
        if (snapshot == null) return;
        if ((callId == null || callId.equals(snapshot.callId)) && snapshot.state == State.TERMINAL) {
            prefs(context).edit().clear().commit();
        }
    }

    private static boolean matches(Context context, String callId) {
        Snapshot snapshot = get(context);
        return snapshot != null && callId != null && callId.equals(snapshot.callId);
    }

    private static State parseState(String value) {
        try { return value == null ? null : State.valueOf(value); }
        catch (IllegalArgumentException ignored) { return null; }
    }

    private static String clean(String value) {
        if (value == null) return null;
        String clean = value.trim();
        return clean.isEmpty() || clean.length() > 2048 ? null : clean;
    }
}
