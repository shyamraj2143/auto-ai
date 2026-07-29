package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class CallNotificationManager {
    private static final String TAG = "AutoAiCallNotif";
    public static final String CHANNEL_INCOMING_LEGACY = "auto_ai_incoming_calls";
    public static final String CHANNEL_INCOMING_V3 = "auto_ai_incoming_calls_v3";
    public static final String CHANNEL_INCOMING_V4 = "auto_ai_incoming_calls_v4";
    public static final String CHANNEL_INCOMING_V5 = "auto_ai_incoming_calls_v5";
    public static final String CHANNEL_INCOMING = "auto_ai_incoming_calls_v6";
    public static final String CHANNEL_ACTIVE = "auto_ai_active_calls";
    public static final String EXTRA_CALL_ID = "call_id";
    public static final String EXTRA_CALLER_ID = "caller_id";
    public static final String EXTRA_CALLER_NAME = "caller_name";
    public static final String EXTRA_CALLER_USERNAME = "caller_username";
    public static final String EXTRA_CALLER_AVATAR = "caller_avatar_url";
    public static final String EXTRA_CALL_TYPE = "call_type";
    public static final String EXTRA_EXPIRES_AT = "expires_at_epoch_ms";
    public static final String EXTRA_ACTION = "call_action";
    public static final String EXTRA_ACTION_TOKEN = "action_token";
    public static final String EXTRA_CALL_REVISION = "call_revision";
    public static final String ACTION_ACCEPT = "AUTOAI_CALL_ACCEPT";
    public static final String ACTION_REJECT = "AUTOAI_CALL_REJECT";
    public static final String ACTION_AUDIO_ONLY = "AUTOAI_CALL_AUDIO_ONLY";
    public static final String ACTION_END = "AUTOAI_CALL_END";
    private static final String PREFS = "auto_ai_calls";
    private static final String PENDING_CALL_ID = "pending_call_id";
    private static final String PENDING_ACTION = "pending_action";
    private static final String PENDING_EXPIRES_AT = "pending_expires_at";
    private static final String SEEN_EVENT_IDS = "seen_event_ids";
    private static final String CALL_REVISION_PREFIX = "call_revision:";
    private static final int MAX_SEEN_EVENTS = 80;
    private static final ExecutorService ACK_EXECUTOR = Executors.newSingleThreadExecutor();

    private CallNotificationManager() {}

    public static void showIncoming(Context context, Map<String, String> data) {
        if (data == null) {
            Log.w(TAG, "Incoming call FCM ignored: missing data.");
            return;
        }
        String callId = value(data, "call_id");
        String callerId = value(data, "caller_id");
        String name = value(data, "caller_name");
        String username = value(data, "caller_username");
        String callType = value(data, "call_type");
        String eventId = value(data, "event_id");
        String actionToken = value(data, "action_token");
        long revision = parseLong(data.get("call_revision"));
        long expiresAt = parseLong(data.get("expires_at_epoch_ms"));
        if (callId.isEmpty() || actionToken.isEmpty()) {
            Log.w(TAG, "Incoming call FCM ignored: missing call_id.");
            return;
        }
        if (isEventSeen(context, eventId) || callId.equals(pendingCallId(context))) {
            diagnostic(context, "FCM_DUPLICATE_IGNORED", data, "DUPLICATE");
            return;
        }
        if (!"audio".equals(callType) && !"video".equals(callType)) {
            Log.w(TAG, "Incoming call FCM ignored callId=" + callId + " reason=invalid_type");
            return;
        }
        if (expiresAt <= System.currentTimeMillis()) {
            diagnostic(context, "FCM_EXPIRED", data, "EXPIRED");
            return;
        }
        if (!acceptRevision(context, callId, revision)) {
            Log.i(TAG, "Incoming call FCM stale revision ignored callId=" + callId + " revision=" + revision);
            return;
        }
        if (!canPostNotifications(context)) {
            diagnostic(context, "NOTIFICATION_PERMISSION_DENIED", data, "POST_NOTIFICATIONS_DENIED");
            return;
        }
        // Firebase invokes onMessageReceived on the application main thread. Never block
        // incoming-call presentation on a synchronous HTTP request here: Android throws
        // NetworkOnMainThreadException and valid calls are silently discarded. The data
        // message is authenticated by FCM, bounded by expiresAt/eventId, and the accept
        // path revalidates the authoritative call state before media starts.
        boolean silent = Boolean.parseBoolean(data.get("silent"));
        ActiveCallStore.presentIncoming(context, callId, callType, callerId, name,
            value(data, "caller_avatar_url"), actionToken, revision, expiresAt);
        Log.i(TAG, "INCOMING_PRESENTED callId=" + callId);
        savePending(context, callId, null, expiresAt);
        createChannels(context);
        TelecomCallResult telecomResult = TelecomCallResult.REGISTRATION_UNAVAILABLE;

        Intent incomingIntent = new Intent(context, IncomingCallActivity.class);
        incomingIntent.putExtra(EXTRA_CALL_ID, callId);
        if (!callerId.isEmpty()) incomingIntent.putExtra(EXTRA_CALLER_ID, callerId);
        incomingIntent.putExtra(EXTRA_CALLER_NAME, name);
        incomingIntent.putExtra(EXTRA_CALLER_USERNAME, username);
        incomingIntent.putExtra(EXTRA_CALLER_AVATAR, value(data, "caller_avatar_url"));
        incomingIntent.putExtra(EXTRA_CALL_TYPE, callType);
        incomingIntent.putExtra(EXTRA_EXPIRES_AT, expiresAt);
        incomingIntent.putExtra(EXTRA_ACTION_TOKEN, actionToken);
        incomingIntent.putExtra(EXTRA_CALL_REVISION, revision);
        PendingIntent fullScreen = PendingIntent.getActivity(context, requestCode(callId, "open", revision), incomingIntent, pendingFlags());

        Intent acceptIntent = new Intent(incomingIntent).setAction(ACTION_ACCEPT);
        acceptIntent.putExtra(EXTRA_ACTION, "accept");
        PendingIntent accept = PendingIntent.getActivity(context, requestCode(callId, "accept", revision), acceptIntent, pendingFlags());
        Intent audioOnlyIntent = new Intent(incomingIntent).setAction(ACTION_AUDIO_ONLY);
        audioOnlyIntent.putExtra(EXTRA_ACTION, "audio_only");
        PendingIntent audioOnly = PendingIntent.getActivity(context, requestCode(callId, "audio_only", revision), audioOnlyIntent, pendingFlags());
        Intent rejectIntent = new Intent(context, CallActionReceiver.class).setAction(ACTION_REJECT)
            .putExtra(EXTRA_CALL_ID, callId).putExtra(EXTRA_ACTION_TOKEN, actionToken);
        PendingIntent reject = PendingIntent.getBroadcast(context, requestCode(callId, "decline", revision), rejectIntent, pendingFlags());

        diagnostic(context, "CALLSTYLE_BUILD_STARTED", data, "STARTED");
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_INCOMING);
        String title = name.isEmpty() ? "Incoming Auto-AI call" : name;
        String text = (username.isEmpty() ? "" : "@" + username + " - ") + "Incoming " + ("audio".equals(callType) ? "audio" : "video") + " call";
        builder.setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_CALL)
            .setPriority(Notification.PRIORITY_MAX)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setLocalOnly(false)
            .setContentIntent(fullScreen);
        if (canUseFullScreenIntent(context)) {
            builder.setFullScreenIntent(fullScreen, true);
            diagnostic(context, "FULL_SCREEN_PERMISSION_AVAILABLE", data, "FULL_SCREEN_ATTACHED");
            diagnostic(context, "FULL_SCREEN_LAUNCH_REQUESTED", data, "REQUESTED");
        } else {
            diagnostic(context, "FULL_SCREEN_PERMISSION_DENIED", data, "HEADS_UP_REQUIRED");
            diagnostic(context, "HEADS_UP_FALLBACK_USED", data, "POSTED_WITHOUT_FULL_SCREEN");
        }
        builder.setTimeoutAfter(Math.max(1000, expiresAt - System.currentTimeMillis()));
        Person person = new Person.Builder().setName(name.isEmpty() ? "Auto-AI user" : name).setImportant(true).build();
        builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, reject, accept));
        if ("video".equals(callType)) builder.addAction(new NotificationCompat.Action(android.R.drawable.sym_action_call, "Audio only", audioOnly));
        diagnostic(context, "CALLSTYLE_BUILD_COMPLETED", data, "ANSWER_REJECT_ATTACHED");
        if (silent) {
            builder.setSound(null);
            builder.setVibrate(new long[] {0L});
        }
        NotificationManager manager = manager(context);
        if (manager != null) {
            try {
                diagnostic(context, "NATIVE_NOTIFICATION_CREATED", data, "CREATED");
                Notification notification = builder.build();
                int incomingNotificationId = notificationId(callId);
                // Remove only the degraded Google Play Services fallback identity.
                manager.cancel(notificationTag(callId), 0);
                manager.notify(incomingNotificationId, notification);
                markEventSeen(context, eventId);
                diagnostic(context, "NATIVE_NOTIFICATION_POSTED", data, "POSTED");
                diagnostic(context, "CALLSTYLE_NOTIFICATION_POSTED", data, "PRIMARY_NATIVE_CALLSTYLE_DELIVERED");
                CallDeliveryAckWorker.schedule(context, data, "callstyle_posted", "", "");
                acknowledgeRinging(context, callId);
                IncomingCallRingingService.start(context, callId, expiresAt, notification, data);
                telecomResult = AutoAiTelecomBridge.reportIncomingCall(context, data);
                if (!telecomResult.isReported()) {
                    Log.w(TAG, "Incoming Telecom presentation degraded callId=" + callId + " result=" + telecomResult);
                }
                Log.i(TAG, "Incoming call notification shown callId=" + callId + " silent=" + silent
                    + " telecom=" + telecomResult.isReported());
            } catch (RuntimeException notificationError) {
                diagnostic(context, "NOTIFICATION_POST_FAILED", data, "NOTIFICATION_POST_FAILED");
                Log.e(TAG, "Incoming call notification post failed callId=" + callId, notificationError);
            }
        } else {
            Log.w(TAG, "Incoming call notification not shown callId=" + callId + " reason=no_notification_manager");
        }
    }

    public static void cancel(Context context, String callId) {
        IncomingCallRingingService.stop(context, callId);
        cancelNotification(context, callId);
        AutoAiTelecomBridge.disconnectLocal(context, callId);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (callId != null && callId.equals(prefs.getString(PENDING_CALL_ID, null))) clearPending(prefs);
    }

    public static void cancelNotification(Context context, String callId) {
        NotificationManager manager = manager(context);
        if (manager != null && callId != null) {
            manager.cancel(notificationId(callId));
            manager.cancel(notificationTag(callId), 0);
            manager.cancel(legacyNotificationId(callId));
        }
    }

    public static void cancelIncomingPresentation(Context context, String callId) {
        cancelNotification(context, callId);
        Log.i(TAG, "Incoming presentation cancelled callId=" + callId);
    }

    public static void showOngoingCall(Context context, String callId) {
        // CallForegroundService owns creation of this foreground notification.
        Log.i(TAG, "Ongoing call presentation ready callId=" + callId);
    }

    public static void cancelOngoingCall(Context context, String callId) {
        NotificationManager notificationManager = manager(context);
        if (notificationManager != null && callId != null) {
            notificationManager.cancel(notificationId(callId) + 100000);
        }
    }

    public static void cancelAllForTerminalCall(Context context, String callId) {
        cancelAllForCall(context, callId);
        AcceptedCallHandoffStore.setState(context, callId, AcceptedCallHandoffStore.State.TERMINAL);
        AcceptedCallHandoffStore.clearTerminal(context, callId);
    }

    public static void cancelAllForCall(Context context, String callId) {
        cancel(context, callId);
        NotificationManager notificationManager = manager(context);
        if (notificationManager != null && callId != null) {
            notificationManager.cancel(legacyNotificationId(callId));
        }
        if (AutoAiCallsPlugin.isActiveCall(context, callId)) {
            context.stopService(new Intent(context, CallForegroundService.class));
            AutoAiCallsPlugin.clearActiveCall(context, callId);
        }
        Log.i(TAG, "All call notifications cancelled callId=" + callId);
    }

    public static boolean acceptRevision(Context context, String callId, long revision) {
        if (callId == null || callId.trim().isEmpty() || revision <= 0) return true;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String key = CALL_REVISION_PREFIX + callId;
        long current = prefs.getLong(key, 0L);
        if (revision < current) return false;
        prefs.edit().putLong(key, revision).apply();
        return true;
    }

    public static String pendingCallId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long expiresAt = prefs.getLong(PENDING_EXPIRES_AT, 0L);
        if (expiresAt > 0 && expiresAt <= System.currentTimeMillis()) {
            clearPending(prefs);
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

    public static int legacyNotificationId(String callId) {
        return notificationId(callId) + 100000;
    }

    public static String notificationTag(String callId) {
        return "autoai_call_" + callId;
    }

    static int requestCode(String callId, String action, long revision) {
        String identity = String.valueOf(callId) + ":" + action + ":" + revision;
        return 200000 + Math.abs(identity.hashCode() % 800000);
    }

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = manager(context);
        if (manager == null) return;
        NotificationChannel incoming = new NotificationChannel(CHANNEL_INCOMING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        incoming.setDescription("Incoming Auto-AI audio and video calls");
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        incoming.enableVibration(true);
        incoming.setVibrationPattern(new long[] {0L, 500L, 250L, 500L, 250L, 700L});
        incoming.setShowBadge(false);
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

    private static boolean canUseFullScreenIntent(Context context) {
        NotificationManager notificationManager = manager(context);
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            || (notificationManager != null && notificationManager.canUseFullScreenIntent());
    }

    private static boolean isEventSeen(Context context, String eventId) {
        if (eventId == null || eventId.trim().isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> seen = new HashSet<>(prefs.getStringSet(SEEN_EVENT_IDS, new HashSet<>()));
        return seen.contains(eventId);
    }

    private static void markEventSeen(Context context, String eventId) {
        if (eventId == null || eventId.trim().isEmpty()) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> seen = new HashSet<>(prefs.getStringSet(SEEN_EVENT_IDS, new HashSet<>()));
        if (seen.size() >= MAX_SEEN_EVENTS) seen.clear();
        seen.add(eventId);
        prefs.edit().putStringSet(SEEN_EVENT_IDS, seen).apply();
    }

    private static void clearPending(SharedPreferences prefs) {
        prefs.edit()
            .remove(PENDING_CALL_ID)
            .remove(PENDING_ACTION)
            .remove(PENDING_EXPIRES_AT)
            .apply();
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
                Log.i(TAG, "Ringing ACK sent callId=" + callId);
            } catch (Exception ignored) {
                Log.w(TAG, "Ringing ACK failed callId=" + callId, ignored);
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

    static void diagnostic(Context context, String event, Map<String, String> data, String resultCode) {
        String installation = PushTokenRegistrar.deviceId(context, "auto_ai_call_device", "fallback_device_id");
        String installationHash = "unknown";
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(installation.getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (int index = 0; index < 8; index++) value.append(String.format("%02x", digest[index]));
            installationHash = value.toString();
        } catch (Exception ignored) { }
        Log.i(TAG, event + " call_id=" + value(data, "call_id") + " trace_id=" + value(data, "trace_id")
            + " event_id=" + value(data, "event_id") + " installation_hash=" + installationHash
            + " sdk=" + Build.VERSION.SDK_INT + " manufacturer=" + Build.MANUFACTURER
            + " app_version=" + BuildConfig.VERSION_NAME + " result=" + resultCode + " timestamp=" + System.currentTimeMillis());
    }
}
