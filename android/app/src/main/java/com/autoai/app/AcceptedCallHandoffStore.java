package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Durable, process-safe state for the native Accept to WebView handoff. */
public final class AcceptedCallHandoffStore {
    public enum State {
        ACCEPT_REQUESTED, ACCEPT_COMMITTED, SERVICE_STARTING, SERVICE_READY,
        UI_LAUNCHING, UI_READY, SIGNALING, CONNECTED, TERMINAL
    }

    private static final String PREFS = "auto_ai_accepted_call_handoff";
    private static final String CALL_ID = "call_id";
    private static final String ACTION = "action";
    private static final String CALL_TYPE = "call_type";
    private static final String PEER_NAME = "peer_name";
    private static final String ACTION_TOKEN = "action_token";
    private static final String ACCEPTED_AT = "accepted_at";
    private static final String EXPIRES_AT = "expires_at";
    private static final String REVISION = "revision";
    private static final String STATE = "state";

    private AcceptedCallHandoffStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static synchronized boolean beginAccept(Context context, String callId, String callType,
                                                    String peerName, String actionToken, long expiresAt,
                                                    long revision) {
        SharedPreferences prefs = prefs(context);
        String storedCallId = prefs.getString(CALL_ID, null);
        State storedState = state(context);
        if (callId.equals(storedCallId) && storedState != null && storedState != State.TERMINAL) return false;
        prefs.edit().clear()
            .putString(CALL_ID, callId)
            .putString(ACTION, "resume_call")
            .putString(CALL_TYPE, callType)
            .putString(PEER_NAME, peerName)
            .putString(ACTION_TOKEN, actionToken)
            .putLong(EXPIRES_AT, expiresAt)
            .putLong(REVISION, revision)
            .putString(STATE, State.ACCEPT_REQUESTED.name())
            .commit();
        return true;
    }

    public static synchronized void commit(Context context, String callId, long revision) {
        if (!callId.equals(callId(context))) return;
        prefs(context).edit()
            .putLong(ACCEPTED_AT, System.currentTimeMillis())
            .putLong(REVISION, Math.max(revision, revision(context)))
            .putString(STATE, State.ACCEPT_COMMITTED.name())
            .commit();
    }

    public static synchronized void setState(Context context, String callId, State state) {
        if (callId != null && callId.equals(callId(context))) {
            prefs(context).edit().putString(STATE, state.name()).commit();
        }
    }

    public static String callId(Context context) { return prefs(context).getString(CALL_ID, null); }
    public static String callType(Context context) { return prefs(context).getString(CALL_TYPE, null); }
    public static String peerName(Context context) { return prefs(context).getString(PEER_NAME, null); }
    public static long expiresAt(Context context) { return prefs(context).getLong(EXPIRES_AT, 0L); }
    public static long revision(Context context) { return prefs(context).getLong(REVISION, 0L); }
    public static State state(Context context) {
        String value = prefs(context).getString(STATE, null);
        if (value == null) return null;
        try { return State.valueOf(value); } catch (IllegalArgumentException ignored) { return null; }
    }

    public static synchronized void clearTerminal(Context context, String callId) {
        if (callId == null || callId.equals(callId(context))) prefs(context).edit().clear().commit();
    }
}
