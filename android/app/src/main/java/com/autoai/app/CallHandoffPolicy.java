package com.autoai.app;

final class CallHandoffPolicy {
    private CallHandoffPolicy() {}

    static boolean isAcceptAction(String action) {
        return CallNotificationManager.ACTION_ACCEPT.equals(action)
            || CallNotificationManager.ACTION_AUDIO_ONLY.equals(action);
    }

    static boolean isTerminalAction(String action) {
        return CallNotificationManager.ACTION_REJECT.equals(action)
            || CallNotificationManager.ACTION_END.equals(action);
    }

    static int requestCode(String callId, String action) {
        return 400000 + Math.abs((callId + ":" + action).hashCode() % 500000);
    }
}
