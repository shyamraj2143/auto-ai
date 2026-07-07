package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class AutoAiFirebaseMessagingService extends FirebaseMessagingService {
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final String UPDATE_NOTIFICATION_CHANNEL_ID = "auto_ai_updates";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        PushTokenRegistrar.registerAsync(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
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

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
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
