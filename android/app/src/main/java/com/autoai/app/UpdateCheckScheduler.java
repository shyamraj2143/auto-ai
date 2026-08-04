package com.autoai.app;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** Schedules resilient update delivery even when FCM or the foreground app is delayed. */
public final class UpdateCheckScheduler {
    private static final String LEGACY_UPDATE_WORK_NAME = "auto_ai_update_check";
    private static final String IMMEDIATE_UPDATE_WORK_NAME = "auto_ai_update_check_now_v2";
    private static final String PERIODIC_UPDATE_WORK_NAME = "auto_ai_update_check_periodic_v2";

    private UpdateCheckScheduler() {
    }

    public static void schedule(Context context) {
        Context appContext = context.getApplicationContext();
        WorkManager manager = WorkManager.getInstance(appContext);
        manager.cancelUniqueWork(LEGACY_UPDATE_WORK_NAME);

        Constraints connected = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest immediate = new OneTimeWorkRequest.Builder(UpdateCheckWorker.class)
            .setConstraints(connected)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build();
        manager.enqueueUniqueWork(
            IMMEDIATE_UPDATE_WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            immediate
        );

        PeriodicWorkRequest periodic = new PeriodicWorkRequest.Builder(
            UpdateCheckWorker.class,
            15,
            TimeUnit.MINUTES
        )
            .setConstraints(connected)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build();
        manager.enqueueUniquePeriodicWork(
            PERIODIC_UPDATE_WORK_NAME,
            ExistingPeriodicWorkPolicy.UPDATE,
            periodic
        );
    }

    /**
     * Kept for old call sites and old installed APKs. It now removes only the retired
     * work name and immediately installs the resilient scheduler instead of disabling it.
     */
    public static void cancelLegacy(Context context) {
        schedule(context);
    }
}
