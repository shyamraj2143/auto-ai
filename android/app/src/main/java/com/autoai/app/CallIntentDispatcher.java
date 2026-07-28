package com.autoai.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Durable call-intent router. It never routes accepted calls through MainActivity/WebView. */
public final class CallIntentDispatcher {
    public interface Callback {
        default void onServiceStarting() {}
        default void onServiceReady() {}
        default void onFailure(String errorCode) {}
    }

    public static final String ACTION_UI_READY = "com.autoai.app.call.ACTIVE_UI_READY";
    private static final String TAG = "AutoAiCallIntent";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private CallIntentDispatcher() {}

    public static void startServiceAndOpen(Context context, ActiveCallStore.Snapshot call, Callback callback) {
        if (call == null || !call.isUsable()) { callback.onFailure("CALL_STATE_CONFLICT"); return; }
        Context app = context.getApplicationContext();
        ActiveCallStore.update(app, call.callId, ActiveCallStore.State.SERVICE_STARTING);
        callback.onServiceStarting();
        Handler handler = new Handler(Looper.getMainLooper());
        BroadcastReceiver receiver = new BroadcastReceiver() {
            private boolean finished;
            private void finish() {
                if (finished) return;
                finished = true;
                handler.removeCallbacksAndMessages(this);
                try { app.unregisterReceiver(this); } catch (IllegalArgumentException ignored) {}
            }
            @Override public void onReceive(Context ignored, Intent result) {
                if (!call.callId.equals(result.getStringExtra(CallNotificationManager.EXTRA_CALL_ID))) return;
                String status = result.getStringExtra(CallForegroundService.EXTRA_SERVICE_STATUS);
                if (CallForegroundService.SERVICE_READY.equals(status)) {
                    finish(); callback.onServiceReady(); launchActive(context, ActiveCallStore.get(app, call.callId));
                } else if (CallForegroundService.SERVICE_FAILED.equals(status)) {
                    finish(); callback.onFailure(result.getStringExtra(CallForegroundService.EXTRA_ERROR_CODE));
                }
            }
        };
        IntentFilter filter = new IntentFilter(CallForegroundService.ACTION_SERVICE_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else app.registerReceiver(receiver, filter);
        handler.postDelayed(() -> {
            try { app.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { return; }
            callback.onFailure("SERVICE_READY_TIMEOUT");
        }, 12_000L);
        Intent service = new Intent(app, CallForegroundService.class).setAction(CallForegroundService.ACTION_START)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, call.callId)
            .putExtra(CallNotificationManager.EXTRA_CALLER_NAME, call.peerName)
            .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, call.callType);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(service); else app.startService(service);
        } catch (RuntimeException error) {
            try { app.unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
            callback.onFailure("FOREGROUND_SERVICE_START_NOT_ALLOWED");
        }
    }

    public static void launchActive(Context context, ActiveCallStore.Snapshot call) {
        if (call == null || !call.isUsable()) return;
        ActiveCallStore.update(context, call.callId, ActiveCallStore.State.ACTIVE_UI_STARTING);
        Intent intent = new Intent(context, ActiveCallActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, call.callId)
            .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, call.callType)
            .putExtra(CallNotificationManager.EXTRA_CALLER_NAME, call.peerName)
            .putExtra(CallNotificationManager.EXTRA_CALLER_AVATAR, call.peerAvatar)
            .putExtra(CallNotificationManager.EXTRA_ACTION, "resume_call");
        context.startActivity(intent);
        Log.i(TAG, "ACTIVE_UI_STARTING callId=" + call.callId);
    }

    public static void dispatchMainFallback(Context context, Intent intent) {
        String callId = intent == null ? null : clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        if (callId == null) return;
        EXECUTOR.execute(() -> {
            try {
                JSONObject call = new NativeCallApi(context).getCall(callId);
                String status = call.optString("status", "");
                ActiveCallStore.Snapshot stored = ActiveCallStore.get(context, callId);
                if ("accepted".equals(status) || "connecting".equals(status) || "active".equals(status)) {
                    if (stored == null) {
                        JSONObject peer = call.optJSONObject("peer");
                        ActiveCallStore.presentIncoming(context, callId, call.optString("call_type", "audio"), null,
                            peer == null ? "Auto-AI user" : peer.optString("display_name", "Auto-AI user"),
                            peer == null ? null : peer.optString("avatar_url", null), null,
                            call.optLong("revision", 0L), System.currentTimeMillis() + 86_400_000L);
                        ActiveCallStore.commitAccept(context, callId, call.optLong("revision", 0L));
                        stored = ActiveCallStore.get(context, callId);
                    }
                    ActiveCallStore.Snapshot resume = stored;
                    new Handler(Looper.getMainLooper()).post(() -> startServiceAndOpen(context, resume, new Callback() {}));
                } else if (("initiated".equals(status) || "ringing".equals(status)) && stored != null) {
                    ActiveCallStore.Snapshot incoming = stored;
                    new Handler(Looper.getMainLooper()).post(() -> context.startActivity(incomingIntent(context, incoming)));
                } else {
                    CallNotificationManager.cancelAllForTerminalCall(context, callId);
                    new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(context, "This call has already ended.", Toast.LENGTH_LONG).show());
                }
            } catch (Exception error) {
                Log.w(TAG, "Call fallback reconciliation failed callId=" + callId, error);
            }
        });
    }

    public static Intent incomingIntent(Context context, ActiveCallStore.Snapshot call) {
        return new Intent(context, IncomingCallActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, call.callId)
            .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, call.callType)
            .putExtra(CallNotificationManager.EXTRA_CALLER_NAME, call.peerName)
            .putExtra(CallNotificationManager.EXTRA_CALLER_AVATAR, call.peerAvatar)
            .putExtra(CallNotificationManager.EXTRA_ACTION_TOKEN, call.actionToken)
            .putExtra(CallNotificationManager.EXTRA_EXPIRES_AT, call.expiresAt)
            .putExtra(CallNotificationManager.EXTRA_CALL_REVISION, call.revision);
    }

    private static String clean(String value) { return value == null || value.trim().isEmpty() ? null : value.trim(); }
}
