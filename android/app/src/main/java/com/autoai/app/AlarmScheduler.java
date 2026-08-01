package com.autoai.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

final class AlarmScheduler {
    static final String ACTION_FIRE = "com.autoai.app.alarm.FIRE";
    static final String EXTRA_ALARM_ID = "alarm_id";
    static final String EXTRA_REVISION = "alarm_revision";
    static final long MISSED_ALARM_GRACE_MS = 12L * 60L * 60L * 1000L;

    static final class Result {
        final boolean scheduled;
        final boolean exact;
        Result(boolean scheduled, boolean exact) { this.scheduled = scheduled; this.exact = exact; }
    }

    private AlarmScheduler() {}

    static Result schedule(Context context, AlarmPayload payload) {
        boolean ringableState = payload != null && ("scheduled".equals(payload.status) || "ringing".equals(payload.status));
        if (payload == null || !payload.valid() || !payload.enabled || !ringableState) {
            if (payload != null) cancel(context, payload.alarmId);
            return new Result(false, canScheduleExact(context));
        }
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return new Result(false, false);
        long now = System.currentTimeMillis();
        long triggerAt = payload.scheduledAtEpochMs;
        if (triggerAt < now - MISSED_ALARM_GRACE_MS) return new Result(false, canScheduleExact(context));
        if (triggerAt <= now) triggerAt = now + 750L;
        PendingIntent pending = pendingIntent(context, payload.alarmId, payload.revision, PendingIntent.FLAG_UPDATE_CURRENT);
        boolean exact = canScheduleExact(context);
        if (exact) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
            else manager.setExact(AlarmManager.RTC_WAKEUP, triggerAt, pending);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
        } else {
            manager.set(AlarmManager.RTC_WAKEUP, triggerAt, pending);
        }
        return new Result(true, exact);
    }

    static int rescheduleAll(Context context) {
        int scheduled = 0;
        for (AlarmPayload payload : AlarmStore.all(context)) if (schedule(context, payload).scheduled) scheduled++;
        return scheduled;
    }

    static void cancel(Context context, String alarmId) {
        if (alarmId == null || alarmId.trim().isEmpty()) return;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        PendingIntent existing = pendingIntent(context, alarmId, 0, PendingIntent.FLAG_NO_CREATE);
        if (existing != null) {
            manager.cancel(existing);
            existing.cancel();
        }
    }

    static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        return manager != null && manager.canScheduleExactAlarms();
    }

    private static PendingIntent pendingIntent(Context context, String alarmId, int revision, int behaviorFlag) {
        Intent intent = new Intent(context, AlarmReceiver.class)
            .setAction(ACTION_FIRE)
            .setData(Uri.parse("autoai://alarm/" + Uri.encode(alarmId)))
            .putExtra(EXTRA_ALARM_ID, alarmId)
            .putExtra(EXTRA_REVISION, revision);
        int flags = behaviorFlag;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, AlarmPayload.requestCode(alarmId), intent, flags);
    }
}
