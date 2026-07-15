package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class AutoAiFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "AutoAiFcm";
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final String UPDATE_NOTIFICATION_CHANNEL_ID = "auto_ai_updates";
    private static final String CHAT_NOTIFICATION_CHANNEL_ID = "auto_ai_messages";
    private static final String MISSED_CALL_CHANNEL_ID = "auto_ai_missed_calls";
    private static final String SOCIAL_CHANNEL_ID = "auto_ai_social";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.i(TAG, "FCM token rotated; scheduling backend registration.");
        PushTokenRegistrar.registerAsync(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String messageType = data.get("type");
        Log.i(TAG, "FCM received type=" + messageType + " callId=" + data.get("call_id"));
        if ("incoming_call".equals(messageType)) {
            CallNotificationManager.showIncoming(this, data);
            return;
        }
        if ("call_missed".equals(messageType)) {
            CallNotificationManager.cancel(this, data.get("call_id"));
            if (Boolean.parseBoolean(data.get("show_missed"))) showMissedCallNotification(data);
            return;
        }
        if (messageType != null && messageType.startsWith("call_")) {
            CallNotificationManager.cancel(this, data.get("call_id"));
            return;
        }
        if ("chat_message".equals(messageType)) {
            showChatNotification(data, message.getNotification());
            return;
        }
        if ("remote-start".equals(messageType)) {
            AutoAiMonitoringService.start(this);
            return;
        }
        if ("ai-clean".equals(messageType)) {
            AutoAiMonitoringService.clearLocalCache(this);
            return;
        }
        int versionCode = parseInt(data.get("version_code"));
        if (versionCode > 0 && versionCode <= BuildConfig.VERSION_CODE) return;

        String title = data.get("title");
        String body = data.get("body");
        RemoteMessage.Notification notification = message.getNotification();
        if ((title == null || title.trim().isEmpty()) && notification != null) {
            title = notification.getTitle();
        }
        if ((body == null || body.trim().isEmpty()) && notification != null) {
            body = notification.getBody();
        }
        if (title == null || title.trim().isEmpty()) {
            title = "Auto-AI update available";
        }
        if (body == null || body.trim().isEmpty()) {
            String versionName = data.get("version_name");
            body = versionName == null || versionName.trim().isEmpty()
                ? "A new Auto-AI app update is ready to install."
                : "Version " + versionName + " is ready to install.";
        }
        showNotification(versionCode, title, body);
    }

    private void showChatNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createChatNotificationChannel();
        String threadId = data.get("thread_id");
        if (threadId == null || threadId.trim().isEmpty()) return;
        String messageId = data.get("message_id");
        String title = data.get("sender_name");
        String body = data.get("preview");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI message";
        if (body == null || body.trim().isEmpty()) body = "New message";

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("open_chat_thread_id", threadId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 5000 + Math.abs(threadId.hashCode() % 100000), intent, flags);
        PendingIntent markRead = PendingIntent.getBroadcast(
            this,
            6100 + Math.abs(threadId.hashCode() % 100000),
            MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_MARK_READ, threadId, messageId),
            flags
        );
        PendingIntent mute = PendingIntent.getBroadcast(
            this,
            6200 + Math.abs(threadId.hashCode() % 100000),
            MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_MUTE, threadId, messageId),
            flags
        );
        Intent replyIntent = MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_REPLY, threadId, messageId);
        PendingIntent reply = PendingIntent.getBroadcast(this, 6300 + Math.abs(threadId.hashCode() % 100000), replyIntent, mutablePendingFlags());
        RemoteInput remoteInput = new RemoteInput.Builder(MessageActionReceiver.KEY_TEXT_REPLY)
            .setLabel("Reply")
            .build();

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHAT_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_send, "Reply", reply).addRemoteInput(remoteInput).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_view, "Mark read", markRead).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_lock_silent_mode, "Mute", mute).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(5000 + Math.abs(threadId.hashCode() % 100000), builder.build());
    }

    private void showMissedCallNotification(Map<String, String> data) {
        if (!canPostNotifications()) return;
        createMissedCallNotificationChannel();
        String callId = data.get("call_id");
        if (callId == null || callId.trim().isEmpty()) return;
        String callType = "audio".equals(data.get("call_type")) ? "audio" : "video";
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 7000 + Math.abs(callId.hashCode() % 100000), intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, MISSED_CALL_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Missed Auto-AI call")
            .setContentText("You missed an " + callType + " call")
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(7000 + Math.abs(callId.hashCode() % 100000), builder.build());
    }

    private void showNotification(int versionCode, String title, String body) {
        if (!canPostNotifications()) return;
        if (versionCode > 0) {
            int lastNotifiedVersion = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
                .getInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, 0);
            if (lastNotifiedVersion >= versionCode) return;
        }

        createUpdateNotificationChannel();
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, UPDATE_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
        if (versionCode > 0) {
            getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, versionCode)
                .apply();
        }
    }

    private void createUpdateNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            UPDATE_NOTIFICATION_CHANNEL_ID,
            "Auto-AI updates",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Auto-AI APK update alerts");
        manager.createNotificationChannel(channel);
    }

    private void createChatNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHAT_NOTIFICATION_CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Auto-AI message alerts");
        manager.createNotificationChannel(channel);
    }

    private void createMissedCallNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel missed = new NotificationChannel(
            MISSED_CALL_CHANNEL_ID,
            "Missed calls",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        missed.setDescription("Auto-AI missed call alerts");
        manager.createNotificationChannel(missed);
        NotificationChannel social = new NotificationChannel(
            SOCIAL_CHANNEL_ID,
            "Social",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        social.setDescription("Auto-AI social and follow alerts");
        manager.createNotificationChannel(social);
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private int mutablePendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return flags;
    }

    private int parseInt(String value) {
        if (value == null) return 0;
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }
}
