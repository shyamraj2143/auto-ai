package com.autoai.app;

import android.content.Context;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

public final class UpdateCheckScheduler {
    private static final String UPDATE_WORK_NAME = "auto_ai_update_check";

    private UpdateCheckScheduler() {
    }

    public static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
            UpdateCheckWorker.class,
            15,
            TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
            UPDATE_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            request
        );
    }
}
