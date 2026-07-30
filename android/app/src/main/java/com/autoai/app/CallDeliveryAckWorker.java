package com.autoai.app;

import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.TimeUnit;

public final class CallDeliveryAckWorker extends Worker {
    private static final String TAG = "AutoAiCallAck";

    public CallDeliveryAckWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context, Map<String, String> callData, String stage, String originalPriority, String deliveredPriority) {
        String callId = value(callData, "call_id");
        String eventId = value(callData, "event_id");
        if (callId.isEmpty() || eventId.isEmpty()) return;
        Data input = new Data.Builder()
            .putString("call_id", callId).putString("event_id", eventId).putString("stage", stage)
            .putString("delivery_mode", value(callData, "delivery_mode").isEmpty() ? "native_primary" : value(callData, "delivery_mode"))
            .putString("original_priority", originalPriority).putString("delivered_priority", deliveredPriority).build();
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(CallDeliveryAckWorker.class)
            .setInputData(input).setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build();
        WorkManager.getInstance(context).enqueueUniqueWork("call-ack-" + callId + "-" + eventId + "-" + stage, ExistingWorkPolicy.KEEP, work);
    }

    @NonNull @Override public Result doWork() {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(getApplicationContext(), "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return Result.success();
        HttpURLConnection connection = null;
        try {
            String callId = getInputData().getString("call_id");
            URL url = new URL(BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "") + "/calls/" + callId + "/delivery-ack");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(12000); connection.setReadTimeout(15000); connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8"); connection.setDoOutput(true);
            JSONObject body = new JSONObject();
            body.put("event_id", getInputData().getString("event_id"));
            body.put("installation_id", PushTokenRegistrar.deviceId(getApplicationContext(), "auto_ai_call_device", "fallback_device_id"));
            body.put("stage", getInputData().getString("stage")); body.put("delivery_mode", getInputData().getString("delivery_mode"));
            body.put("original_priority", getInputData().getString("original_priority")); body.put("delivered_priority", getInputData().getString("delivered_priority"));
            body.put("received_at", Instant.now().toString());
            try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) return Result.success();
            if (status == 401 || status >= 500 || status == 408 || status == 429) return Result.retry();
            Log.w(TAG, "Delivery ACK rejected status=" + status); return Result.failure();
        } catch (Exception error) {
            Log.w(TAG, "Delivery ACK failed", error); return Result.retry();
        } finally { if (connection != null) connection.disconnect(); }
    }

    private static String value(Map<String, String> data, String key) {
        String value = data.get(key); return value == null ? "" : value.trim();
    }
}
