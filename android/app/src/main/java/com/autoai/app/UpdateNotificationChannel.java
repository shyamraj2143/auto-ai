package com.autoai.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

/** Owns the stable notification channel used by every APK update delivery path. */
public final class UpdateNotificationChannel {
    public static final String ID = "auto_ai_updates";
    private static final String LEGACY_ID = "app_updates";
    private static final String NAME = "AutoAI updates";
    private static final String DESCRIPTION = "Verified AutoAI application updates";

    private UpdateNotificationChannel() {
    }

    /**
     * Creates the canonical channel and retains the previous FCM channel for old installed
     * builds. Notification-channel settings are platform-owned and cannot be copied safely.
     */
    public static void create(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        create(manager, ID);
        create(manager, LEGACY_ID);
    }

    private static void create(NotificationManager manager, String id) {
        NotificationChannel channel = new NotificationChannel(id, NAME, NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(DESCRIPTION);
        manager.createNotificationChannel(channel);
    }
}
