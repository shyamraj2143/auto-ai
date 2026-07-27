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
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class CallActionReceiver extends BroadcastReceiver {
    private static final String TAG = "AutoAiCallAction";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final Set<String> ACTIONS_IN_FLIGHT = ConcurrentHashMap.newKeySet();

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID);
        if (callId == null || callId.trim().isEmpty()) return;
        String action = intent.getAction();
        String actionToken = intent.getStringExtra(CallNotificationManager.EXTRA_ACTION_TOKEN);
        boolean accepting = CallNotificationManager.ACTION_ACCEPT.equals(action) || CallNotificationManager.ACTION_AUDIO_ONLY.equals(action);
        if (!accepting && !CallNotificationManager.ACTION_REJECT.equals(action) && !CallNotificationManager.ACTION_END.equals(action)) return;
        String endpoint = accepting ? "accept" : CallNotificationManager.ACTION_REJECT.equals(action) ? "reject" : "end";
        String flightKey = callId + ":" + endpoint;
        if (!ACTIONS_IN_FLIGHT.add(flightKey)) return;
        Log.i(TAG, "Call notification action received callId=" + callId + " action=" + endpoint);
        CallNotificationManager.cancel(context, callId);
        AutoAiTelecomBridge.disconnectLocal(context, callId);
        context.stopService(new Intent(context, CallForegroundService.class));
        PendingResult pendingResult = goAsync();
        EXECUTOR.execute(() -> {
            try {
                if (sendAction(context, callId, endpoint, actionToken) && accepting) {
                    Intent service = new Intent(context, CallForegroundService.class).setAction(CallForegroundService.ACTION_START)
                        .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId)
                        .putExtra(CallNotificationManager.EXTRA_CALLER_NAME, intent.getStringExtra(CallNotificationManager.EXTRA_CALLER_NAME))
                        .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, CallNotificationManager.ACTION_AUDIO_ONLY.equals(action) ? "audio" : intent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE));
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) context.startForegroundService(service); else context.startService(service);
                    Intent activeUi = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
                    context.startActivity(activeUi);
                }
            } finally { ACTIONS_IN_FLIGHT.remove(flightKey); pendingResult.finish(); }
        });
    }

    private boolean sendAction(Context context, String callId, String action, String actionToken) {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return false;
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
            return status >= 200 && status < 300;
        } catch (Exception ignored) {
            Log.w(TAG, "Call notification action failed callId=" + callId + " action=" + action, ignored);
            // The web client revalidates and repeats the action when connectivity returns.
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
