package com.autoai.app;

import android.content.Context;

/** Compatibility facade for code written before ActiveCallStore became authoritative. */
public final class AcceptedCallHandoffStore {
    public enum State {
        ACCEPT_REQUESTED, ACCEPT_COMMITTED, SERVICE_STARTING, SERVICE_READY,
        UI_LAUNCHING, UI_READY, SIGNALING, CONNECTED, TERMINAL
    }

    private AcceptedCallHandoffStore() {}

    public static boolean beginAccept(Context context, String callId, String callType, String peerName,
                                      String actionToken, long expiresAt, long revision) {
        return ActiveCallStore.beginAccept(context, callId, callType, peerName, actionToken, expiresAt, revision);
    }

    public static void commit(Context context, String callId, long revision) {
        ActiveCallStore.commitAccept(context, callId, revision);
    }

    public static void setState(Context context, String callId, State state) {
        ActiveCallStore.update(context, callId, map(state));
    }

    public static String callId(Context context) { ActiveCallStore.Snapshot s = ActiveCallStore.get(context); return s == null ? null : s.callId; }
    public static String callType(Context context) { ActiveCallStore.Snapshot s = ActiveCallStore.get(context); return s == null ? null : s.callType; }
    public static String peerName(Context context) { ActiveCallStore.Snapshot s = ActiveCallStore.get(context); return s == null ? null : s.peerName; }
    public static long expiresAt(Context context) { ActiveCallStore.Snapshot s = ActiveCallStore.get(context); return s == null ? 0L : s.expiresAt; }
    public static long revision(Context context) { ActiveCallStore.Snapshot s = ActiveCallStore.get(context); return s == null ? 0L : s.revision; }

    public static State state(Context context) {
        ActiveCallStore.Snapshot s = ActiveCallStore.get(context);
        if (s == null || s.state == null) return null;
        switch (s.state) {
            case ACCEPT_REQUESTED: return State.ACCEPT_REQUESTED;
            case ACCEPT_COMMITTED: return State.ACCEPT_COMMITTED;
            case SERVICE_STARTING: return State.SERVICE_STARTING;
            case SERVICE_READY: return State.SERVICE_READY;
            case ACTIVE_UI_STARTING: return State.UI_LAUNCHING;
            case ACTIVE_UI_READY: return State.UI_READY;
            case SIGNALING_CONNECTING:
            case SIGNALING_CONNECTED: return State.SIGNALING;
            case MEDIA_CONNECTED: return State.CONNECTED;
            case TERMINAL: return State.TERMINAL;
            default: return State.SERVICE_READY;
        }
    }

    public static void clearTerminal(Context context, String callId) {
        ActiveCallStore.clearTerminal(context, callId);
    }

    private static ActiveCallStore.State map(State state) {
        switch (state) {
            case ACCEPT_REQUESTED: return ActiveCallStore.State.ACCEPT_REQUESTED;
            case ACCEPT_COMMITTED: return ActiveCallStore.State.ACCEPT_COMMITTED;
            case SERVICE_STARTING: return ActiveCallStore.State.SERVICE_STARTING;
            case SERVICE_READY: return ActiveCallStore.State.SERVICE_READY;
            case UI_LAUNCHING: return ActiveCallStore.State.ACTIVE_UI_STARTING;
            case UI_READY: return ActiveCallStore.State.ACTIVE_UI_READY;
            case SIGNALING: return ActiveCallStore.State.SIGNALING_CONNECTING;
            case CONNECTED: return ActiveCallStore.State.MEDIA_CONNECTED;
            default: return ActiveCallStore.State.TERMINAL;
        }
    }
}
