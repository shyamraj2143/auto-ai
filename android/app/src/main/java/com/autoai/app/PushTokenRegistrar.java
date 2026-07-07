package com.autoai.app;

import android.content.Context;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class PushTokenRegistrar {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private PushTokenRegistrar() {
    }

    public static void registerAsync(Context context, String token) {
        if (token == null || token.trim().isEmpty()) return;
        Context appContext = context.getApplicationContext();
        EXECUTOR.execute(() -> register(appContext, token.trim()));
    }

    private static void register(Context context, String token) {
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
        } catch (Exception ignored) {
            // Push token sync should never block normal app usage.
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
