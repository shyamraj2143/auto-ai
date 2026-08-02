package com.autoai.app;

import android.content.Context;

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

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;

public final class AlarmActionSyncWorker extends Worker {
    private static final String KEY_ALARM_ID = "alarm_id";
    private static final String KEY_ACTION = "action";
    private static final String KEY_SNOOZE_MINUTES = "snooze_minutes";
    private static final String KEY_SCHEDULED_AT_EPOCH_MS = "scheduled_at_epoch_ms";
    private static final String KEY_CLIENT_REVISION = "client_revision";
    private static final String ACCESS_TOKEN_KEY = "auto-ai-access-token";
    private static final String REFRESH_TOKEN_KEY = "auto-ai-refresh-token";
    private static final Object REFRESH_LOCK = new Object();

    public AlarmActionSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void enqueue(
        Context context,
        String alarmId,
        String action,
        int snoozeMinutes,
        long scheduledAtEpochMs,
        int clientRevision
    ) {
        Data input = new Data.Builder()
            .putString(KEY_ALARM_ID, alarmId)
            .putString(KEY_ACTION, action)
            .putInt(KEY_SNOOZE_MINUTES, snoozeMinutes)
            .putLong(KEY_SCHEDULED_AT_EPOCH_MS, scheduledAtEpochMs)
            .putInt(KEY_CLIENT_REVISION, clientRevision)
            .build();
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AlarmActionSyncWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
            "auto_ai_alarm_action_" + alarmId,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            request
        );
    }

    @NonNull @Override public Result doWork() {
        String alarmId = getInputData().getString(KEY_ALARM_ID);
        String action = getInputData().getString(KEY_ACTION);
        if (alarmId == null || action == null) return Result.failure();
        String token = AutoAiSecureStoragePlugin.readStoredValue(getApplicationContext(), ACCESS_TOKEN_KEY);
        if ((token == null || token.trim().isEmpty()) && refreshSession()) {
            token = AutoAiSecureStoragePlugin.readStoredValue(getApplicationContext(), ACCESS_TOKEN_KEY);
        }
        if (token == null || token.trim().isEmpty()) return boundedRetry();
        int status;
        try {
            status = sendAction(token, alarmId, action);
            if (status == 401 && refreshSession()) {
                String refreshed = AutoAiSecureStoragePlugin.readStoredValue(getApplicationContext(), ACCESS_TOKEN_KEY);
                if (refreshed != null && !refreshed.trim().isEmpty()) status = sendAction(refreshed, alarmId, action);
            }
        } catch (Exception ignored) {
            return boundedRetry();
        }
        if ((status >= 200 && status < 300) || status == 404) return Result.success();
        if (status == 403 || getRunAttemptCount() >= 5) return Result.failure();
        return Result.retry();
    }

    private int sendAction(String token, String alarmId, String action) throws Exception {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trim(BuildConfig.AUTO_AI_API_BASE_URL) + "/alarms/" + alarmId + "/action");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(25_000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + token.trim());
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            JSONObject body = new JSONObject().put("action", action)
                .put("snooze_minutes", getInputData().getInt(KEY_SNOOZE_MINUTES, 10));
            int revision = getInputData().getInt(KEY_CLIENT_REVISION, 0);
            long scheduledAt = getInputData().getLong(KEY_SCHEDULED_AT_EPOCH_MS, 0L);
            if (revision > 0) body.put("client_revision", revision);
            if (scheduledAt > 0L) body.put("scheduled_at", isoUtc(scheduledAt));
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            return connection.getResponseCode();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean refreshSession() {
        synchronized (REFRESH_LOCK) {
            String refreshToken = AutoAiSecureStoragePlugin.readStoredValue(getApplicationContext(), REFRESH_TOKEN_KEY);
            if (refreshToken == null || refreshToken.trim().isEmpty()) return false;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(trim(BuildConfig.AUTO_AI_API_BASE_URL) + "/auth/refresh").openConnection();
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(25_000);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setDoOutput(true);
                JSONObject request = new JSONObject().put("refresh_token", refreshToken.trim());
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(request.toString().getBytes(StandardCharsets.UTF_8));
                }
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) return false;
                JSONObject response = new JSONObject(readBody(connection));
                String accessToken = response.optString("access_token", "").trim();
                String nextRefreshToken = response.optString("refresh_token", "").trim();
                if (accessToken.isEmpty()) return false;
                AutoAiSecureStoragePlugin.writeStoredValue(getApplicationContext(), ACCESS_TOKEN_KEY, accessToken);
                if (!nextRefreshToken.isEmpty()) {
                    AutoAiSecureStoragePlugin.writeStoredValue(getApplicationContext(), REFRESH_TOKEN_KEY, nextRefreshToken);
                }
                return true;
            } catch (Exception ignored) {
                return false;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    private String readBody(HttpURLConnection connection) throws Exception {
        StringBuilder body = new StringBuilder();
        InputStream stream = connection.getInputStream();
        if (stream == null) return "";
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && body.length() < 32_000) body.append(line);
        }
        return body.toString();
    }

    private Result boundedRetry() {
        return getRunAttemptCount() >= 5 ? Result.failure() : Result.retry();
    }

    private static String isoUtc(long epochMs) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(epochMs));
    }

    private static String trim(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
