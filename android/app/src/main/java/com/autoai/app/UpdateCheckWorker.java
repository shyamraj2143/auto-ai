package com.autoai.app;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** One-shot cleanup shim for APKs that persisted the retired periodic updater. */
public final class UpdateCheckWorker extends Worker {
    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters workerParams) {
        super(context, workerParams);
    }

    @NonNull @Override public Result doWork() {
        UpdateCheckScheduler.cancelLegacy(getApplicationContext());
        return Result.success();
    }
}
