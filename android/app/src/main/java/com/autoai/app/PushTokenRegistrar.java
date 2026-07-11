package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PushTokenRegistrar {
    private static final String TAG = "AutoAiPushToken";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushTokenRegistrar() {
    }

    public static void registerAsync(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        Context appContext = context.getApplicationContext();
        Log.i(TAG, "Scheduling push token registration.");
        EXECUTOR.execute(() -> {
            String cleanToken = token.trim();
            registerUpdateToken(appContext, cleanToken);
            registerUserDevice(appContext, cleanToken);
        });
    }

    public static String deviceId(Context context, String preferencesName, String fallbackKey) {
        String androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        if (androidId != null && !androidId.trim().isEmpty()) return androidId.trim();

        SharedPreferences preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
        String fallbackId = preferences.getString(fallbackKey, null);
        if (fallbackId == null || fallbackId.trim().isEmpty()) {
            fallbackId = UUID.randomUUID().toString();
            preferences.edit().putString(fallbackKey, fallbackId).apply();
        }
        return fallbackId;
    }

    public static String deviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String value = (manufacturer + " " + model).trim();
        return value.isEmpty() ? "Android device" : value.substring(0, Math.min(120, value.length()));
    }

    private static void registerUpdateToken(Context context, String token) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/notifications/device-token");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("token", token);
            body.put("platform", "android");
            body.put("app_version", BuildConfig.VERSION_NAME);
            body.put("version_code", BuildConfig.VERSION_CODE);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("Push token register failed: " + status);
            }
            Log.i(TAG, "Update push token registered status=" + status);
        } catch (Exception ignored) {
            Log.w(TAG, "Update push token registration failed.", ignored);
            // Push token sync should never block normal app usage.
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static void registerUserDevice(Context context, String token) {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) {
            Log.i(TAG, "User call device registration skipped; no stored access token.");
            return;
        }
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/calls/devices/register");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("device_id", deviceId(context, "auto_ai_call_device", "fallback_device_id"));
            body.put("platform", "android");
            body.put("fcm_token", token);
            body.put("app_version", BuildConfig.VERSION_NAME);
            body.put("app_version_code", BuildConfig.VERSION_CODE);
            body.put("device_name", deviceName());
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException(String.format(Locale.US, "User device register failed: %d", status));
            }
            Log.i(TAG, "User call device registered status=" + status);
        } catch (Exception ignored) {
            Log.w(TAG, "User call device registration failed.", ignored);
            // Background push registration must never block app startup or token rotation.
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
