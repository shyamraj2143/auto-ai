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
        final long triggerAtEpochMs;
        final String method;
        final String reason;

        Result(boolean scheduled, boolean exact, long triggerAtEpochMs, String method, String reason) {
            this.scheduled = scheduled;
            this.exact = exact;
            this.triggerAtEpochMs = triggerAtEpochMs;
            this.method = method;
            this.reason = reason;
        }
    }

    private AlarmScheduler() {}

    static Result schedule(Context context, AlarmPayload payload) {
        boolean ringableState = payload != null && ("scheduled".equals(payload.status) || "ringing".equals(payload.status));
        if (payload == null || !payload.valid() || !payload.enabled || !ringableState) {
            if (payload != null) cancel(context, payload.alarmId);
            return new Result(false, canScheduleExact(context), 0L, "none", "alarm_not_ringable");
        }
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return new Result(false, false, 0L, "none", "alarm_manager_unavailable");
        long now = System.currentTimeMillis();
        long triggerAt = payload.scheduledAtEpochMs;
        if (triggerAt < now - MISSED_ALARM_GRACE_MS) {
            return new Result(false, canScheduleExact(context), triggerAt, "none", "alarm_expired");
        }
        if (triggerAt <= now) triggerAt = now + 750L;
        boolean exact = canScheduleExact(context);
        if (!exact) {
            // A one-minute wake-up alarm must never be silently downgraded to an inexact
            // alarm. Android can defer that fallback in Doze, which previously let the UI
            // report success even though the alarm was not armed for its requested time.
            return new Result(false, false, triggerAt, "none", "exact_alarm_access_required");
        }
        PendingIntent pending = pendingIntent(context, payload.alarmId, payload.revision, PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent show = AlarmRingingActivity.pendingIntent(context, payload);
        try {
            manager.setAlarmClock(new AlarmManager.AlarmClockInfo(triggerAt, show), pending);
        } catch (SecurityException denied) {
            return new Result(false, false, triggerAt, "none", "exact_alarm_access_required");
        } catch (RuntimeException failure) {
            return new Result(false, true, triggerAt, "none", "schedule_failed");
        }
        return new Result(true, true, triggerAt, "alarm_clock", "");
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
