package com.autoai.app;

import android.content.Context;

import androidx.work.WorkManager;

public final class UpdateCheckScheduler {
    private static final String UPDATE_WORK_NAME = "auto_ai_update_check";

    private UpdateCheckScheduler() {
    }

    public static void schedule(Context context) {
        cancelLegacy(context);
    }

    public static void cancelLegacy(Context context) {
        WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(UPDATE_WORK_NAME);
    }
}
