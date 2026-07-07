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
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

public class UpdateCheckWorker extends Worker {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final String UPDATE_NOTIFICATION_CHANNEL_ID = "auto_ai_updates";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters workerParams) {
        super(context, workerParams);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            ApkUpdate update = fetchLatestUpdate();
            if (update.versionCode > BuildConfig.VERSION_CODE) {
                showUpdateNotification(update);
            }
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        }
    }

    private ApkUpdate fetchLatestUpdate() throws Exception {
        URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/download/apk/latest");
        HttpURLConnection connection = openSecureConnection(url);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Update check failed: " + status);
        }

        JSONObject json = new JSONObject(readResponseBody(connection));
        ApkUpdate update = new ApkUpdate();
        update.versionCode = json.optInt("version_code", 0);
        update.versionName = json.optString("version_name", json.optString("version", ""));
        update.changelog = json.optString("changelog", "");
        return update;
    }

    private void showUpdateNotification(ApkUpdate update) {
        Context context = getApplicationContext();
        if (!canPostNotifications(context)) return;
        int lastNotifiedVersion = context
            .getSharedPreferences(UPDATE_PREFERENCES, Context.MODE_PRIVATE)
            .getInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, 0);
        if (lastNotifiedVersion >= update.versionCode) return;

        createUpdateNotificationChannel(context);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, intent, flags);

        String body = "Version " + update.versionName + " is ready to install.";
        if (!update.changelog.trim().isEmpty()) {
            body += " " + update.changelog.trim();
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, UPDATE_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Auto-AI update available")
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
        context
            .getSharedPreferences(UPDATE_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, update.versionCode)
            .apply();
    }

    private void createUpdateNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            UPDATE_NOTIFICATION_CHANNEL_ID,
            "Auto-AI updates",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Auto-AI APK update alerts");
        manager.createNotificationChannel(channel);
    }

    private boolean canPostNotifications(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private HttpURLConnection openSecureConnection(URL url) throws Exception {
        String protocol = url.getProtocol().toLowerCase(Locale.US);
        String host = url.getHost().toLowerCase(Locale.US);
        boolean allowed = "https".equals(protocol) || ("http".equals(protocol) && ("localhost".equals(host) || "127.0.0.1".equals(host)));
        if (!allowed) {
            throw new SecurityException("APK updates require HTTPS.");
        }
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }

    private String readResponseBody(HttpURLConnection connection) throws Exception {
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString("UTF-8");
        }
    }

    private String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }

    private static class ApkUpdate {
        int versionCode;
        String versionName = "";
        String changelog = "";
    }
}
