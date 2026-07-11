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
        if (!CallNotificationManager.ACTION_REJECT.equals(action) && !CallNotificationManager.ACTION_END.equals(action)) return;
        String endpoint = CallNotificationManager.ACTION_REJECT.equals(action) ? "reject" : "end";
        Log.i(TAG, "Call notification action received callId=" + callId + " action=" + endpoint);
        CallNotificationManager.cancel(context, callId);
        context.stopService(new Intent(context, CallForegroundService.class));
        PendingResult pendingResult = goAsync();
        EXECUTOR.execute(() -> {
            try { sendAction(context, callId, endpoint); }
            finally { pendingResult.finish(); }
        });
    }

    private void sendAction(Context context, String callId, String action) {
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
