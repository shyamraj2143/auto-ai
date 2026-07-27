package com.autoai.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
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
    private static final String TOKEN_PREFERENCES = "auto_ai_push_token";
    private static final String LAST_FCM_TOKEN = "last_fcm_token";
    private static final String LAST_FIREBASE_INSTALLATION_ID = "last_firebase_installation_id";
    private static final String INSTALLATION_ID_FILE = "auto_ai_installation_id";
    private static final String LEGACY_INSTALLATION_ID = "legacy_installation_id";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushTokenRegistrar() {
    }

    public static void registerAsync(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        Context appContext = context.getApplicationContext();
        Log.i(TAG, "Scheduling push token registration.");
        EXECUTOR.execute(() -> {
            String cleanToken = token.trim();
            appContext.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE).edit().putString(LAST_FCM_TOKEN, cleanToken).apply();
            registerUpdateToken(appContext, cleanToken);
            registerUserDevice(appContext, cleanToken);
        });
    }

    public static void registerInstallationAsync(Context context, String installationId) {
        if (clean(installationId) == null) return;
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> registerInstallationBlocking(appContext, installationId, null));
    }

    public static boolean registerInstallationBlocking(Context context, String installationId, String rotatingFromHash) {
        String cleanInstallationId = clean(installationId);
        if (cleanInstallationId == null) return false;
        context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(LAST_FIREBASE_INSTALLATION_ID, cleanInstallationId)
            .remove(LAST_FCM_TOKEN)
            .apply();
        return registerUserDevice(context, cleanInstallationId, cleanInstallationId, rotatingFromHash);
    }

    public static void registerStoredUserDeviceIfAuthenticated(Context context) {
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> {
            SharedPreferences preferences = appContext.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE);
            String installationId = clean(preferences.getString(LAST_FIREBASE_INSTALLATION_ID, null));
            if (installationId != null) {
                registerUserDevice(appContext, installationId, installationId, null);
                return;
            }
            String token = preferences.getString(LAST_FCM_TOKEN, null);
            if (token == null || token.trim().isEmpty()) {
                Log.i(TAG, "User device registration retry skipped; no stored FCM identity.");
                return;
            }
            registerUserDevice(appContext, token.trim());
        });
    }

    public static synchronized String deviceId(Context context, String preferencesName, String fallbackKey) {
        File identityFile = new File(context.getNoBackupFilesDir(), INSTALLATION_ID_FILE);
        String existing = readIdentity(identityFile);
        if (existing != null) return existing;
        SharedPreferences preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
        String legacy = clean(preferences.getString(fallbackKey, null));
        String installationId = UUID.randomUUID().toString();
        if (legacy != null) preferences.edit().putString(LEGACY_INSTALLATION_ID, legacy).remove(fallbackKey).apply();
        writeIdentity(identityFile, installationId);
        Log.i(TAG, "Installation identity created migration=" + (legacy == null ? "fresh" : "legacy_detected"));
        return installationId;
    }

    public static String legacyDeviceId(Context context, String preferencesName) {
        return clean(context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(LEGACY_INSTALLATION_ID, null));
    }

    public static String deviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        String value = (manufacturer + " " + model).trim();
        return value.isEmpty() ? "Android device" : value.substring(0, Math.min(120, value.length()));
    }

    public static boolean hasStoredToken(Context context) {
        String token = context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE).getString(LAST_FCM_TOKEN, null);
        return token != null && !token.trim().isEmpty();
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
        registerUserDevice(context, token, null, null);
    }

    private static boolean registerUserDevice(Context context, String token, String firebaseInstallationId, String rotatingFromHash) {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) {
            Log.i(TAG, "User call device registration skipped; no stored access token.");
            return false;
        }
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/devices/register");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);

            JSONObject body = new JSONObject();
            body.put("deviceId", deviceId(context, "auto_ai_call_device", "fallback_device_id"));
            String legacyDeviceId = legacyDeviceId(context, "auto_ai_call_device");
            if (legacyDeviceId != null) body.put("legacyDeviceId", legacyDeviceId);
            body.put("platform", "android");
            body.put("fcmToken", token);
            if (firebaseInstallationId != null) body.put("firebaseInstallationId", firebaseInstallationId);
            if (rotatingFromHash != null) body.put("rotatingFromFirebaseInstallationHash", rotatingFromHash);
            body.put("appVersion", BuildConfig.VERSION_NAME);
            body.put("appVersionCode", BuildConfig.VERSION_CODE);
            body.put("deviceName", deviceName());
            body.put("androidSdk", Build.VERSION.SDK_INT);
            body.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
            body.put("model", Build.MODEL == null ? "" : Build.MODEL);
            body.put("osVersion", Build.VERSION.RELEASE == null ? "Android" : "Android " + Build.VERSION.RELEASE);
            JSONObject permissions = new JSONObject();
            permissions.put("notification", Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
            body.put("permissionsStatus", permissions);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IllegalStateException(String.format(Locale.US, "User device register failed: %d", status));
            }
            Log.i(TAG, "User call device registered status=" + status);
            return true;
        } catch (Exception ignored) {
            Log.w(TAG, "User call device registration failed.", ignored);
            // Background push registration must never block app startup or token rotation.
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readIdentity(File file) {
        if (!file.isFile()) return null;
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] bytes = new byte[128];
            int count = input.read(bytes);
            return clean(count <= 0 ? null : new String(bytes, 0, count, StandardCharsets.UTF_8));
        } catch (Exception error) {
            Log.w(TAG, "Unable to read installation identity.", error);
            return null;
        }
    }

    public static String sha256Prefix(String value) {
        if (clean(value) == null) return "none";
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                .digest(value.trim().getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (int index = 0; index < 8; index++) result.append(String.format(Locale.US, "%02x", digest[index]));
            return result.toString();
        } catch (Exception ignored) {
            return "unavailable";
        }
    }

    private static void writeIdentity(File file, String value) {
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to persist installation identity.", error);
        }
    }

    private static String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    private static String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
