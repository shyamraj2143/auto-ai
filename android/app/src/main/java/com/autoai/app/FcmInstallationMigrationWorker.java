package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.google.android.gms.tasks.Tasks;
import com.google.firebase.installations.FirebaseInstallations;
import com.google.firebase.messaging.FirebaseMessaging;

import java.util.concurrent.TimeUnit;

public final class FcmInstallationMigrationWorker extends Worker {
    static final String MIGRATION = "fcm_native_call_installation_reset_v34";
    private static final String PREFERENCES = "auto_ai_fcm_migrations";
    private static final String COMPLETED = MIGRATION + "_completed";

    public FcmInstallationMigrationWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context) {
        if (BuildConfig.VERSION_CODE < 34 || completed(context)) return;
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(FcmInstallationMigrationWorker.class)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(context).enqueueUniqueWork(MIGRATION, ExistingWorkPolicy.KEEP, request);
    }

    static boolean completed(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(COMPLETED, false);
    }

    @NonNull @Override public Result doWork() {
        Context context = getApplicationContext();
        if (completed(context)) return Result.success();
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return Result.success();
        try {
            FirebaseInstallations installations = FirebaseInstallations.getInstance();
            String oldFid = Tasks.await(installations.getId(), 30, TimeUnit.SECONDS);
            String oldHash = PushTokenRegistrar.sha256Prefix(oldFid);
            Log.i("AutoAiFcmMigration", "Starting FCM installation rotation old_fid_hash=" + oldHash);
            Tasks.await(FirebaseMessaging.getInstance().unregister(), 30, TimeUnit.SECONDS);
            Tasks.await(installations.delete(), 30, TimeUnit.SECONDS);
            Tasks.await(FirebaseMessaging.getInstance().register(), 30, TimeUnit.SECONDS);
            String newFid = Tasks.await(installations.getId(), 30, TimeUnit.SECONDS);
            String newToken = Tasks.await(FirebaseMessaging.getInstance().getToken(), 30, TimeUnit.SECONDS);
            if (newFid == null || newFid.equals(oldFid)) return Result.retry();
            if (!PushTokenRegistrar.isUsableFcmToken(newToken, newFid)) return Result.retry();
            if (!PushTokenRegistrar.registerInstallationBlocking(context, newFid, newToken, oldHash)) return Result.retry();
            SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
            preferences.edit().putBoolean(COMPLETED, true).apply();
            Log.i("AutoAiFcmMigration", "FCM installation rotation completed new_fid_hash=" + PushTokenRegistrar.sha256Prefix(newFid));
            return Result.success();
        } catch (Exception error) {
            Log.w("AutoAiFcmMigration", "FCM installation rotation pending", error);
            return Result.retry();
        }
    }
}
