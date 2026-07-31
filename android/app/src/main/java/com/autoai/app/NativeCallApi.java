package com.autoai.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

final class NativeCallApi {
    static final class ApiException extends Exception {
        final int status;
        ApiException(int status, String message) { super(message); this.status = status; }
    }

    private static final String TAG = "AutoAiNativeCallApi";
    private static final String ACCESS_TOKEN_KEY = "auto-ai-access-token";
    private static final String REFRESH_TOKEN_KEY = "auto-ai-refresh-token";
    private static final int MAX_ATTEMPTS = 4;
    private static final Object REFRESH_LOCK = new Object();
    private final Context context;

    NativeCallApi(Context context) { this.context = context.getApplicationContext(); }

    JSONObject getCall(String callId) throws Exception { return request("GET", "/calls/" + encode(callId), null); }
    JSONObject turnCredentials() throws Exception { return request("GET", "/calls/turn-credentials", null); }
    String websocketUrl() throws Exception {
        String ticket = request("POST", "/calls/ws-ticket", new JSONObject()).getString("ticket");
        String base = trim(BuildConfig.AUTO_AI_API_BASE_URL);
        if (base.startsWith("https://")) base = "wss://" + base.substring(8);
        else if (base.startsWith("http://")) base = "ws://" + base.substring(7);
        return base + "/calls/ws?ticket=" + encode(ticket);
    }

    long accept(String callId, String actionToken, long fallbackRevision) throws Exception {
        JSONObject body = new JSONObject()
            .put("device_id", PushTokenRegistrar.deviceId(context, "auto_ai_call_device", "fallback_device_id"));
        if (actionToken != null && !actionToken.trim().isEmpty()) body.put("action_token", actionToken.trim());
        return request("POST", "/calls/" + encode(callId) + "/accept", body).optLong("revision", fallbackRevision);
    }

    void end(String callId, String reason) throws Exception {
        request("POST", "/calls/" + encode(callId) + "/end", new JSONObject().put("end_reason", reason));
    }

    void reject(String callId, String actionToken) throws Exception {
        JSONObject body = new JSONObject();
        if (actionToken != null && !actionToken.trim().isEmpty()) body.put("action_token", actionToken.trim());
        request("POST", "/calls/" + encode(callId) + "/reject", body);
    }

    void fail(String callId, String errorCode) throws Exception {
        request("POST", "/calls/" + encode(callId) + "/fail", new JSONObject()
            .put("failure_code", errorCode)
            .put("source_device", PushTokenRegistrar.deviceId(context, "auto_ai_call_device", "fallback_device_id")));
    }

    private JSONObject request(String method, String path, JSONObject body) throws Exception {
        Exception last = null;
        boolean refreshAttempted = false;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                return requestOnce(method, path, body);
            } catch (ApiException error) {
                last = error;
                if (error.status == 401 && !refreshAttempted) {
                    refreshAttempted = true;
                    if (refreshSession()) {
                        attempt--;
                        continue;
                    }
                }
                if (!isTransientStatus(error.status) || attempt == MAX_ATTEMPTS) throw error;
            } catch (IOException error) {
                last = error;
                if (attempt == MAX_ATTEMPTS) throw error;
            }
            try {
                Thread.sleep(Math.min(2400L, 300L * (1L << (attempt - 1))));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            }
        }
        throw last == null ? new IOException("Call request failed.") : last;
    }

    private JSONObject requestOnce(String method, String path, JSONObject body) throws Exception {
        String token = AutoAiSecureStoragePlugin.readStoredValue(context, ACCESS_TOKEN_KEY);
        if (token == null || token.trim().isEmpty()) {
            if (refreshSession()) token = AutoAiSecureStoragePlugin.readStoredValue(context, ACCESS_TOKEN_KEY);
        }
        if (token == null || token.trim().isEmpty()) throw new ApiException(401, "Missing call authentication.");

        HttpURLConnection connection = null;
        try {
            connection = openConnection(path, method);
            connection.setRequestProperty("Authorization", "Bearer " + token.trim());
            if (body != null) writeJson(connection, body);
            int status = connection.getResponseCode();
            String result = readBody(connection, status);
            if (status < 200 || status >= 300) throw new ApiException(status, result);
            return result.isEmpty() ? new JSONObject() : new JSONObject(result);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private boolean refreshSession() {
        synchronized (REFRESH_LOCK) {
            String refreshToken = AutoAiSecureStoragePlugin.readStoredValue(context, REFRESH_TOKEN_KEY);
            if (refreshToken == null || refreshToken.trim().isEmpty()) return false;

            HttpURLConnection connection = null;
            try {
                connection = openConnection("/auth/refresh", "POST");
                writeJson(connection, new JSONObject().put("refresh_token", refreshToken.trim()));
                int status = connection.getResponseCode();
                String result = readBody(connection, status);
                if (status < 200 || status >= 300) {
                    Log.w(TAG, "Native call session refresh rejected status=" + status);
                    return false;
                }
                JSONObject payload = new JSONObject(result);
                String accessToken = payload.optString("access_token", "").trim();
                String nextRefreshToken = payload.optString("refresh_token", "").trim();
                if (accessToken.isEmpty()) return false;
                AutoAiSecureStoragePlugin.writeStoredValue(context, ACCESS_TOKEN_KEY, accessToken);
                if (!nextRefreshToken.isEmpty()) {
                    AutoAiSecureStoragePlugin.writeStoredValue(context, REFRESH_TOKEN_KEY, nextRefreshToken);
                }
                Log.i(TAG, "Native call session refreshed successfully.");
                return true;
            } catch (Exception error) {
                Log.w(TAG, "Native call session refresh deferred.", error);
                return false;
            } finally {
                if (connection != null) connection.disconnect();
            }
        }
    }

    private HttpURLConnection openConnection(String path, String method) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(trim(BuildConfig.AUTO_AI_API_BASE_URL) + path).openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");
        return connection;
    }

    private static void writeJson(HttpURLConnection connection, JSONObject body) throws IOException {
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private static String readBody(HttpURLConnection connection, int status) throws IOException {
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder result = new StringBuilder();
        if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null && result.length() < 128_000) result.append(line);
        }
        return result.toString();
    }

    private static boolean isTransientStatus(int status) {
        return status == 408 || status == 425 || status == 429 || status == 500
            || status == 502 || status == 503 || status == 504;
    }

    private static String trim(String value) { return value == null ? "" : value.replaceAll("/+$", ""); }
    private static String encode(String value) {
        try { return URLEncoder.encode(value == null ? "" : value, "UTF-8"); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new IllegalStateException(impossible); }
    }
}
