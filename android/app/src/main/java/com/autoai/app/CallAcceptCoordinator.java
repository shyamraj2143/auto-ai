package com.autoai.app;

import android.content.Context;
import android.util.Log;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One idempotent backend Accept and service/UI handoff per call. */
final class CallAcceptCoordinator {
    interface Listener extends CallIntentDispatcher.Callback {
        default void onAcceptCommitted() {}
    }

    private static final String TAG = "AutoAiCallAccept";
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final Set<String> RUNNING = ConcurrentHashMap.newKeySet();

    private CallAcceptCoordinator() {}

    static void accept(Context context, String callId, boolean audioOnly, Listener listener) {
        Context app = context.getApplicationContext();
        ActiveCallStore.Snapshot call = ActiveCallStore.get(app, callId);
        if (call == null || !call.isUsable()) { listener.onFailure("CALL_STATE_CONFLICT"); return; }
        if (call.expiresAt > 0L && call.expiresAt <= System.currentTimeMillis() && call.acceptedAt == 0L) {
            listener.onFailure("CALL_STATE_CONFLICT"); return;
        }
        if (call.acceptedAt > 0L || call.state.ordinal() >= ActiveCallStore.State.ACCEPT_COMMITTED.ordinal()) {
            CallIntentDispatcher.startServiceAndOpen(context, call, listener);
            return;
        }
        if (!RUNNING.add(callId)) return;
        ActiveCallStore.beginAccept(app, call.callId, audioOnly ? "audio" : call.callType, call.peerName,
            call.actionToken, call.expiresAt, call.revision);
        Log.i(TAG, "ACCEPT_TAPPED callId=" + callId);
        EXECUTOR.execute(() -> {
            try {
                long revision = new NativeCallApi(app).accept(callId, call.actionToken, call.revision);
                ActiveCallStore.commitAccept(app, callId, revision);
                CallNotificationManager.cancelIncomingPresentation(app, callId);
                CallNotificationManager.savePending(app, callId, "resume_call", Math.max(call.expiresAt, System.currentTimeMillis() + 86_400_000L));
                Log.i(TAG, "ACCEPT_COMMITTED callId=" + callId + " revision=" + revision);
                listener.onAcceptCommitted();
                CallIntentDispatcher.startServiceAndOpen(context, ActiveCallStore.get(app, callId), listener);
            } catch (Exception error) {
                Log.e(TAG, "Accept failed callId=" + callId, error);
                try { new NativeCallApi(app).fail(callId, "BACKEND_ACCEPT_FAILED"); }
                catch (Exception reportError) { Log.e(TAG, "Accept failure synchronization failed callId=" + callId, reportError); }
                ActiveCallStore.fail(app, callId, "BACKEND_ACCEPT_FAILED");
                CallNotificationManager.cancelAllForTerminalCall(app, callId);
                listener.onFailure("BACKEND_ACCEPT_FAILED");
            } finally {
                RUNNING.remove(callId);
            }
        });
    }
}
