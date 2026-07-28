package com.autoai.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class CallActionReceiver extends BroadcastReceiver {
    private static final String TAG = "AutoAiCallAction";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID);
        if (callId == null || callId.trim().isEmpty()) return;
        String action = intent.getAction();
        String actionToken = intent.getStringExtra(CallNotificationManager.EXTRA_ACTION_TOKEN);
        if (CallHandoffPolicy.isAcceptAction(action)) {
            // Accept is deliberately handed to the single-flight Activity coordinator. No
            // Telecom disconnect, service stop, or terminal notification cleanup is allowed.
            Intent accept = new Intent(context, IncomingCallActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtras(intent)
                .putExtra(CallNotificationManager.EXTRA_ACTION,
                    CallNotificationManager.ACTION_AUDIO_ONLY.equals(action) ? "audio_only" : "accept");
            context.startActivity(accept);
            return;
        }
        if (!CallHandoffPolicy.isTerminalAction(action)) return;
        String endpoint = CallNotificationManager.ACTION_REJECT.equals(action) ? "reject" : "end";
        Log.i(TAG, "Call notification action received callId=" + callId + " action=" + endpoint);
        CallNotificationManager.cancelIncomingPresentation(context, callId);
        PendingResult pendingResult = goAsync();
        EXECUTOR.execute(() -> {
            try {
                sendAction(context, callId, endpoint, actionToken);
                NativeCallSessionController.get(context).terminateAfterBackendAction(callId);
                CallNotificationManager.cancelAllForTerminalCall(context, callId);
                Intent stop = new Intent(context, CallForegroundService.class).setAction(CallForegroundService.ACTION_STOP)
                    .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
                try { context.startService(stop); } catch (RuntimeException error) { Log.w(TAG, "Terminal service stop failed callId=" + callId, error); }
            }
            finally { pendingResult.finish(); }
        });
    }

    private void sendAction(Context context, String callId, String action, String actionToken) {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/calls/" + callId + "/" + action);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            JSONObject body = new JSONObject();
            if (actionToken != null && !actionToken.trim().isEmpty()) body.put("action_token", actionToken.trim());
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            Log.i(TAG, "Call notification action sent callId=" + callId + " action=" + action + " status=" + status);
        } catch (Exception ignored) {
            Log.w(TAG, "Call notification action failed callId=" + callId + " action=" + action, ignored);
            // The web client revalidates and repeats the action when connectivity returns.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
