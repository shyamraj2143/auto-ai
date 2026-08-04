package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.TimeUnit;

/**
 * Background fallback for update delivery.
 *
 * FCM remains the immediate path. This worker protects installations whose push token,
 * battery state, or OEM background rules delayed the notification. It discovers signed
 * metadata, persists the mandatory update and queues the existing certificate-verifying
 * APK download worker. Android still owns the final install confirmation.
 */
public final class UpdateCheckWorker extends Worker {
    private static final String DOWNLOAD_WORK_NAME = "auto_ai_apk_download";
    private static final String GITHUB_RELEASE_API =
        "https://api.github.com/repos/shyamraj2143/auto-ai/releases/latest";
    private static final String UPDATE_CHANNEL_ID = "auto_ai_updates";
    private static final int UPDATE_NOTIFICATION_ID = 1001;

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            AppUpdateCoordinator.Metadata metadata = fetchLatest();
            if (!metadata.valid() || metadata.versionCode <= BuildConfig.VERSION_CODE) {
                return Result.success();
            }
            metadata.forceUpdate = true;
            metadata.mandatory = true;
            queueDownload(metadata);
            showUpdateNotification(metadata);
            return Result.success(new Data.Builder()
                .putInt("version_code", metadata.versionCode)
                .putString("version_name", metadata.versionName)
                .build());
        } catch (java.net.UnknownHostException | java.net.SocketTimeoutException error) {
            return Result.retry();
        } catch (Exception error) {
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure(
                new Data.Builder().putString("error", safeMessage(error)).build()
            );
        }
    }

    private AppUpdateCoordinator.Metadata fetchLatest() throws Exception {
        Exception backendError;
        try {
            return fetchBackend();
        } catch (Exception error) {
            backendError = error;
        }
        try {
            return AppUpdateCoordinator.parseGitHubRelease(
                fetchJson(new URL(GITHUB_RELEASE_API), "application/vnd.github+json")
            );
        } catch (Exception githubError) {
            githubError.addSuppressed(backendError);
            throw githubError;
        }
    }

    private AppUpdateCoordinator.Metadata fetchBackend() throws Exception {
        JSONObject json = fetchJson(
            new URL(AppUpdateCoordinator.apiUrl("download/apk/latest")),
            "application/json"
        );
        AppUpdateCoordinator.Metadata metadata = AppUpdateCoordinator.Metadata.from(json);
        String rawUrl = json.optString("download_url", json.optString("apk_url", ""));
        URI base = URI.create(AppUpdateCoordinator.apiUrl(""));
        URI candidate = URI.create(rawUrl);
        URI resolved = candidate.isAbsolute()
            ? candidate
            : base.resolve(rawUrl.startsWith("/") ? rawUrl : "./" + rawUrl);
        metadata.downloadUrl = resolved.toString();
        if (!AppUpdateCoordinator.isTrustedDownloadUrl(metadata.downloadUrl)) {
            throw new SecurityException("Update metadata returned an untrusted APK URL.");
        }
        return metadata;
    }

    private JSONObject fetchJson(URL url, String accept) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("User-Agent", "AutoAI-Background-Updater/" + BuildConfig.VERSION_NAME);
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Update server returned HTTP " + status + ".");
        }
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(output.toString("UTF-8"));
        }
    }

    private void queueDownload(AppUpdateCoordinator.Metadata metadata) {
        Context context = getApplicationContext();
        SharedPreferences preferences = context.getSharedPreferences(
            AppUpdateCoordinator.PREFS,
            Context.MODE_PRIVATE
        );
        int previousVersion = preferences.getInt("active_download_version", 0);
        ExistingWorkPolicy policy = previousVersion == metadata.versionCode
            ? ExistingWorkPolicy.KEEP
            : ExistingWorkPolicy.REPLACE;

        if (previousVersion > 0 && previousVersion != metadata.versionCode) {
            String previousPath = preferences.getString("downloaded_apk_path", "");
            if (!previousPath.isEmpty()) new java.io.File(previousPath).delete();
        }

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        Data input = new Data.Builder()
            .putString("metadata", metadata.toJson().toString())
            .build();
        OneTimeWorkRequest download = new OneTimeWorkRequest.Builder(AppUpdateDownloadWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build();

        preferences.edit()
            .putString("metadata", metadata.toJson().toString())
            .putString("state", AppUpdateCoordinator.State.QUEUED.name())
            .putLong("downloaded", 0L)
            .putLong("total", metadata.fileSize)
            .putString("message", "Automatic update download queued")
            .putString("error", "")
            .putInt("active_download_version", metadata.versionCode)
            .putString("download_work_id", download.getId().toString())
            .putBoolean("direct_update_active", true)
            .apply();

        WorkManager.getInstance(context).enqueueUniqueWork(
            DOWNLOAD_WORK_NAME,
            policy,
            download
        );
    }

    private void showUpdateNotification(AppUpdateCoordinator.Metadata metadata) {
        Context context = getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                UPDATE_CHANNEL_ID,
                "AutoAI updates",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Automatic verified AutoAI application updates");
            manager.createNotificationChannel(channel);
        }

        Intent intent = new Intent(context, MainActivity.class)
            .putExtra("start_app_update", true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            8100 + Math.abs(metadata.versionCode % 100000),
            intent,
            flags
        );

        String body = metadata.changelog == null || metadata.changelog.trim().isEmpty()
            ? "A verified update is downloading automatically. Tap to install when ready."
            : metadata.changelog.trim();
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, UPDATE_CHANNEL_ID)
            : new Notification.Builder(context);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("AutoAI " + metadata.versionName + " update")
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(false)
            .setOngoing(false)
            .setCategory(Notification.CATEGORY_SYSTEM)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.stat_sys_download_done,
            "Install update",
            pendingIntent
        ).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
            ? "Automatic update check failed."
            : message.substring(0, Math.min(240, message.length()));
    }
}
