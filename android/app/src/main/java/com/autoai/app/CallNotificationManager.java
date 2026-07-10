package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.util.Map;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CallNotificationManager {
    public static final String CHANNEL_INCOMING = "auto_ai_incoming_calls";
    public static final String CHANNEL_ACTIVE = "auto_ai_active_calls";
    public static final String EXTRA_CALL_ID = "call_id";
    public static final String EXTRA_CALLER_ID = "caller_id";
    public static final String EXTRA_CALLER_NAME = "caller_name";
    public static final String EXTRA_CALLER_USERNAME = "caller_username";
    public static final String EXTRA_CALLER_AVATAR = "caller_avatar_url";
    public static final String EXTRA_CALL_TYPE = "call_type";
    public static final String EXTRA_EXPIRES_AT = "expires_at_epoch_ms";
    public static final String EXTRA_ACTION = "call_action";
    public static final String ACTION_ACCEPT = "com.autoai.app.call.ACCEPT";
    public static final String ACTION_REJECT = "com.autoai.app.call.REJECT";
    public static final String ACTION_END = "com.autoai.app.call.END";
    private static final String PREFS = "auto_ai_calls";
    private static final String PENDING_CALL_ID = "pending_call_id";
    private static final String PENDING_ACTION = "pending_action";
    private static final String PENDING_EXPIRES_AT = "pending_expires_at";
    private static final ExecutorService ACK_EXECUTOR = Executors.newSingleThreadExecutor();

    private CallNotificationManager() {}

    public static void showIncoming(Context context, Map<String, String> data) {
        if (data == null) return;
        String callId = value(data, "call_id");
        String callerId = value(data, "caller_id");
        String name = value(data, "caller_name");
        String username = value(data, "caller_username");
        String callType = value(data, "call_type");
        long expiresAt = parseLong(data.get("expires_at_epoch_ms"));
        if (callId.isEmpty() || (!"audio".equals(callType) && !"video".equals(callType)) || expiresAt <= System.currentTimeMillis() || !canPostNotifications(context)) return;
        boolean silent = Boolean.parseBoolean(data.get("silent"));
        savePending(context, callId, null, expiresAt);
        createChannels(context);

        Intent incomingIntent = new Intent(context, IncomingCallActivity.class);
        incomingIntent.putExtra(EXTRA_CALL_ID, callId);
        if (!callerId.isEmpty()) incomingIntent.putExtra(EXTRA_CALLER_ID, callerId);
        incomingIntent.putExtra(EXTRA_CALLER_NAME, name);
        incomingIntent.putExtra(EXTRA_CALLER_USERNAME, username);
        incomingIntent.putExtra(EXTRA_CALLER_AVATAR, value(data, "caller_avatar_url"));
        incomingIntent.putExtra(EXTRA_CALL_TYPE, callType);
        incomingIntent.putExtra(EXTRA_EXPIRES_AT, expiresAt);
        PendingIntent fullScreen = PendingIntent.getActivity(context, notificationId(callId), incomingIntent, pendingFlags());

        Intent acceptIntent = new Intent(incomingIntent);
        acceptIntent.putExtra(EXTRA_ACTION, "accept");
        PendingIntent accept = PendingIntent.getActivity(context, notificationId(callId) + 1, acceptIntent, pendingFlags());
        Intent rejectIntent = new Intent(context, CallActionReceiver.class).setAction(ACTION_REJECT).putExtra(EXTRA_CALL_ID, callId);
        PendingIntent reject = PendingIntent.getBroadcast(context, notificationId(callId) + 2, rejectIntent, pendingFlags());

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, CHANNEL_INCOMING)
            : new Notification.Builder(context);
        String title = name.isEmpty() ? "Incoming Auto-AI call" : name;
        String text = (username.isEmpty() ? "" : "@" + username + " - ") + "Incoming " + ("audio".equals(callType) ? "audio" : "video") + " call";
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_CALL)
            .setPriority(Notification.PRIORITY_MAX)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder.setTimeoutAfter(Math.max(1000, expiresAt - System.currentTimeMillis()));
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Person person = new Person.Builder().setName(name.isEmpty() ? "Auto-AI user" : name).setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher)).setImportant(true).build();
            builder.setStyle(Notification.CallStyle.forIncomingCall(person, reject, accept));
        } else {
            builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Reject", reject).build());
            builder.addAction(new Notification.Action.Builder(android.R.drawable.sym_action_call, "Accept", accept).build());
        }
        if (silent) {
            builder.setSound(null);
            builder.setVibrate(new long[] {0L});
        }
        NotificationManager manager = manager(context);
        if (manager != null) {
            manager.notify(notificationId(callId), builder.build());
            acknowledgeRinging(context, callId);
        }
    }

    public static void cancel(Context context, String callId) {
        cancelNotification(context, callId);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (callId != null && callId.equals(prefs.getString(PENDING_CALL_ID, null))) prefs.edit().clear().apply();
    }

    public static void cancelNotification(Context context, String callId) {
        NotificationManager manager = manager(context);
        if (manager != null && callId != null) manager.cancel(notificationId(callId));
    }

    public static String pendingCallId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long expiresAt = prefs.getLong(PENDING_EXPIRES_AT, 0L);
        if (expiresAt > 0 && expiresAt <= System.currentTimeMillis()) {
            prefs.edit().clear().apply();
            return null;
        }
        return prefs.getString(PENDING_CALL_ID, null);
    }

    public static String pendingAction(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PENDING_ACTION, null);
    }

    public static void savePending(Context context, String callId, String action, long expiresAt) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PENDING_CALL_ID, callId)
            .putString(PENDING_ACTION, action)
            .putLong(PENDING_EXPIRES_AT, expiresAt)
            .apply();
    }

    public static void clearPendingAction(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PENDING_ACTION).apply();
    }

    public static int notificationId(String callId) {
        return 3000 + Math.abs(callId.hashCode() % 100000);
    }

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = manager(context);
        if (manager == null) return;
        NotificationChannel incoming = new NotificationChannel(CHANNEL_INCOMING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        incoming.setDescription("Incoming Auto-AI audio and video calls");
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        incoming.enableVibration(true);
        Uri ringtone = Settings.System.DEFAULT_RINGTONE_URI;
        incoming.setSound(ringtone, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build());
        NotificationChannel active = new NotificationChannel(CHANNEL_ACTIVE, "Active calls", NotificationManager.IMPORTANCE_LOW);
        active.setDescription("Ongoing Auto-AI calls");
        manager.createNotificationChannel(incoming);
        manager.createNotificationChannel(active);
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static boolean canPostNotifications(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private static void acknowledgeRinging(Context context, String callId) {
        ACK_EXECUTOR.execute(() -> {
            String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
            if (accessToken == null || accessToken.trim().isEmpty()) return;
            HttpURLConnection connection = null;
            try {
                URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/calls/" + callId + "/ringing");
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(12000);
                connection.setReadTimeout(15000);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Authorization", "Bearer " + accessToken);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setDoOutput(true);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write("{}".getBytes(StandardCharsets.UTF_8));
                }
                connection.getResponseCode();
            } catch (Exception ignored) {
                // The WebView repeats validation when the user opens or accepts the call.
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private static String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }

    private static String value(Map<String, String> data, String key) {
        String value = data.get(key);
        return value == null ? "" : value.trim();
    }

    private static long parseLong(String value) {
        try { return Long.parseLong(value == null ? "0" : value); }
        catch (NumberFormatException ignored) { return 0L; }
    }
}
