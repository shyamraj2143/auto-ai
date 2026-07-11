package com.autoai.app;

import android.app.NotificationManager;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MessageActionReceiver extends BroadcastReceiver {
    public static final String ACTION_REPLY = "com.autoai.app.MESSAGE_REPLY";
    public static final String ACTION_MARK_READ = "com.autoai.app.MESSAGE_MARK_READ";
    public static final String ACTION_MUTE = "com.autoai.app.MESSAGE_MUTE";
    public static final String EXTRA_THREAD_ID = "thread_id";
    public static final String EXTRA_MESSAGE_ID = "message_id";
    public static final String KEY_TEXT_REPLY = "auto_ai_message_reply";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    public static Intent intent(Context context, String action, String threadId, String messageId) {
        Intent intent = new Intent(context, MessageActionReceiver.class).setAction(action);
        intent.putExtra(EXTRA_THREAD_ID, threadId);
        if (messageId != null) intent.putExtra(EXTRA_MESSAGE_ID, messageId);
        return intent;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String threadId = clean(intent.getStringExtra(EXTRA_THREAD_ID));
        if (threadId == null) return;
        PendingResult pendingResult = goAsync();
        EXECUTOR.execute(() -> {
            try {
                if (ACTION_MARK_READ.equals(action)) {
                    post(context, "/messages/threads/" + encode(threadId) + "/read", "{}");
                    cancelMessageNotification(context, threadId);
                } else if (ACTION_MUTE.equals(action)) {
                    post(context, "/messages/threads/" + encode(threadId) + "/mute", "{\"enabled\":true}");
                    cancelMessageNotification(context, threadId);
                } else if (ACTION_REPLY.equals(action)) {
                    String reply = replyText(intent);
                    if (reply != null) {
                        JSONObject body = new JSONObject();
                        body.put("text_content", reply);
                        body.put("client_message_id", UUID.randomUUID().toString());
                        post(context, "/messages/threads/" + encode(threadId) + "/messages", body.toString());
                        post(context, "/messages/threads/" + encode(threadId) + "/read", "{}");
                        cancelMessageNotification(context, threadId);
                    }
                }
            } catch (Exception ignored) {
                // The web layer will sync state when the app next opens.
            } finally {
                pendingResult.finish();
            }
        });
    }

    private static void post(Context context, String path, String body) throws Exception {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
            connection.getResponseCode();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String replyText(Intent intent) {
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        if (results == null) return null;
        CharSequence value = results.getCharSequence(KEY_TEXT_REPLY);
        String text = value == null ? "" : value.toString().trim();
        return text.isEmpty() ? null : text.substring(0, Math.min(4000, text.length()));
    }

    private static void cancelMessageNotification(Context context, String threadId) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(5000 + Math.abs(threadId.hashCode() % 100000));
    }

    private static String encode(String value) throws Exception {
        return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
    }

    private static String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    private static String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }
}
