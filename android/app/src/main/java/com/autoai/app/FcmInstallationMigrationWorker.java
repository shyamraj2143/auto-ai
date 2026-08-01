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
    static final String MIGRATION = "fcm_fid_direct_send_repair_v35";
    private static final String PREFERENCES = "auto_ai_fcm_migrations";
    private static final String COMPLETED = MIGRATION + "_completed";

    public FcmInstallationMigrationWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    public static void schedule(Context context) {
        if (BuildConfig.VERSION_CODE < 42 || completed(context)) return;
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
            String previousFid = PushTokenRegistrar.storedFirebaseInstallationId(context);
            Tasks.await(FirebaseMessaging.getInstance().register(), 30, TimeUnit.SECONDS);
            String currentFid = Tasks.await(installations.getId(), 30, TimeUnit.SECONDS);
            if (!PushTokenRegistrar.isUsablePushTarget(currentFid)) return Result.retry();
            String rotatingFromHash = previousFid != null && !previousFid.equals(currentFid)
                ? PushTokenRegistrar.sha256Prefix(previousFid) : null;
            if (!PushTokenRegistrar.registerInstallationBlocking(context, currentFid, rotatingFromHash)) return Result.retry();
            SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
            preferences.edit().putBoolean(COMPLETED, true).apply();
            Log.i("AutoAiFcmMigration", "FCM direct-send registration repaired fid_hash=" + PushTokenRegistrar.sha256Prefix(currentFid));
            return Result.success();
        } catch (Exception error) {
            Log.w("AutoAiFcmMigration", "FCM direct-send registration repair pending", error);
            return Result.retry();
        }
    }
}
