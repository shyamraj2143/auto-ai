package com.autoai.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import com.google.firebase.installations.FirebaseInstallations;
import com.google.firebase.messaging.FirebaseMessaging;

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
    private static final String LAST_PUSH_TARGET = "last_push_target";
    private static final String LAST_FCM_TOKEN = "last_fcm_token";
    private static final String LAST_FIREBASE_INSTALLATION_ID = "last_firebase_installation_id";
    private static final String INSTALLATION_ID_FILE = "auto_ai_installation_id";
    private static final String LEGACY_INSTALLATION_ID = "legacy_installation_id";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushTokenRegistrar() {
    }

    public static void registerAsync(Context context, String token) {
        String cleanToken = clean(token);
        if (cleanToken == null) return;
        Context appContext = context.getApplicationContext();
        Log.i(TAG, "Scheduling authenticated push-token registration.");
        EXECUTOR.execute(() -> {
            SharedPreferences preferences = appContext.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE);
            preferences.edit()
                .putString(LAST_PUSH_TARGET, cleanToken)
                .putString(LAST_FCM_TOKEN, cleanToken)
                .commit();
            registerUserDevice(appContext, cleanToken, null, null);
        });
    }

    public static void registerInstallationAsync(Context context, String installationId) {
        if (clean(installationId) == null) return;
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> registerInstallationBlocking(appContext, installationId, null));
    }

    public static boolean registerInstallationBlocking(Context context, String installationId, String rotatingFromHash) {
        String cleanInstallationId = clean(installationId);
        if (!isUsablePushTarget(cleanInstallationId)) {
            Log.w(TAG, "FCM registration deferred; installation id is unavailable.");
            return false;
        }
        context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(LAST_PUSH_TARGET, cleanInstallationId)
            .putString(LAST_FIREBASE_INSTALLATION_ID, cleanInstallationId)
            .commit();
        boolean registered = registerUserDevice(context, cleanInstallationId, cleanInstallationId, rotatingFromHash);
        return registered;
    }

    public static void registerStoredUserDeviceIfAuthenticated(Context context) {
        Context appContext = context.getApplicationContext();
        refreshCurrentRegistrationAsync(appContext);
    }

    public static void refreshCurrentRegistrationAsync(Context context) {
        Context appContext = context.getApplicationContext();
        try {
            FirebaseMessaging.getInstance().register().addOnCompleteListener(registrationTask -> {
                if (!registrationTask.isSuccessful()) {
                    Log.w(TAG, "FCM installation registration failed; retrying the stored target.", registrationTask.getException());
                    EXECUTOR.execute(() -> registerStoredUserDevice(appContext, null));
                    return;
                }
                FirebaseInstallations.getInstance().getId().addOnCompleteListener(fidTask -> {
                    String installationId = fidTask.isSuccessful() ? clean(fidTask.getResult()) : null;
                    if (installationId != null) {
                        registerInstallationAsync(appContext, installationId);
                    } else {
                        Log.w(TAG, "Registered FCM installation id unavailable; retrying the stored target.", fidTask.getException());
                        EXECUTOR.execute(() -> registerStoredUserDevice(appContext, null));
                    }
                });
            });
        } catch (RuntimeException error) {
            Log.w(TAG, "FCM installation refresh failed; retrying the stored target.", error);
            EXECUTOR.execute(() -> registerStoredUserDevice(appContext, null));
        }
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
        SharedPreferences preferences = context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE);
        return firstClean(
            preferences.getString(LAST_PUSH_TARGET, null),
            preferences.getString(LAST_FIREBASE_INSTALLATION_ID, null),
            preferences.getString(LAST_FCM_TOKEN, null)
        ) != null;
    }

    static boolean isUsablePushTarget(String target) {
        return clean(target) != null;
    }

    static String storedFirebaseInstallationId(Context context) {
        return clean(context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE)
            .getString(LAST_FIREBASE_INSTALLATION_ID, null));
    }

    private static boolean registerStoredUserDevice(Context context, String rotatingFromHash) {
        SharedPreferences preferences = context.getSharedPreferences(TOKEN_PREFERENCES, Context.MODE_PRIVATE);
        String storedInstallationId = clean(preferences.getString(LAST_FIREBASE_INSTALLATION_ID, null));
        String target = firstClean(
            preferences.getString(LAST_PUSH_TARGET, null),
            storedInstallationId,
            preferences.getString(LAST_FCM_TOKEN, null)
        );
        if (!isUsablePushTarget(target)) {
            Log.i(TAG, "User device registration retry skipped; no stored FCM target.");
            return false;
        }
        String installationId = target.equals(storedInstallationId) ? storedInstallationId : null;
        boolean registered = registerUserDevice(context, target, installationId, rotatingFromHash);
        return registered;
    }

    private static boolean registerUserDevice(Context context, String target, String firebaseInstallationId, String rotatingFromHash) {
        if (!isUsablePushTarget(target)) {
            Log.w(TAG, "User device registration rejected an empty FCM target.");
            return false;
        }
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
            body.put("fcmToken", target);
            if (firebaseInstallationId != null) body.put("firebaseInstallationId", firebaseInstallationId);
            body.put("pushProvider", firebaseInstallationId != null && firebaseInstallationId.equals(target) ? "fcm_fid" : "fcm");
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

    private static String firstClean(String... values) {
        if (values == null) return null;
        for (String value : values) {
            String cleaned = clean(value);
            if (cleaned != null) return cleaned;
        }
        return null;
    }

    private static String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
