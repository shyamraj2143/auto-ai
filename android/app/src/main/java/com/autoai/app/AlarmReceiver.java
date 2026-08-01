package com.autoai.app;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class AlarmReceiver extends BroadcastReceiver {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
            || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
            || AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED.equals(action)) {
            PendingResult pending = goAsync();
            EXECUTOR.execute(() -> {
                try { Log.i("AutoAiAlarm", "ALARMS_RESTORED count=" + AlarmScheduler.rescheduleAll(context)); }
                finally { pending.finish(); }
            });
            return;
        }
        if (!AlarmScheduler.ACTION_FIRE.equals(action)) return;
        String alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        AlarmPayload payload = AlarmStore.get(context, alarmId);
        if (payload == null || !payload.enabled) return;
        int scheduledRevision = intent.getIntExtra(AlarmScheduler.EXTRA_REVISION, 0);
        if (scheduledRevision > 0 && payload.revision != scheduledRevision) return;
        AlarmRingingService.start(context, payload.alarmId);
    }
}
