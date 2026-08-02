package com.autoai.app;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

public final class AlarmActionReceiver extends BroadcastReceiver {
    static final String ACTION_DISMISS = "com.autoai.app.alarm.DISMISS";
    static final String ACTION_SNOOZE = "com.autoai.app.alarm.SNOOZE";
    static final String ACTION_CHANGED = "com.autoai.app.alarm.CHANGED";
    static final String EXTRA_ACTION = "alarm_action";
    static final String EXTRA_AWAKE_VERIFIED = "awake_verified";
    private static final int SNOOZE_MINUTES = 10;

    @Override public void onReceive(Context context, Intent intent) {
        String alarmId = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        String action = intent == null ? null : intent.getAction();
        if (alarmId == null || alarmId.trim().isEmpty()) return;
        if (!ACTION_SNOOZE.equals(action) && !ACTION_DISMISS.equals(action)) return;
        if (ACTION_DISMISS.equals(action)
            && (intent == null || !intent.getBooleanExtra(EXTRA_AWAKE_VERIFIED, false))) return;
        AlarmRingingService.stop(context, alarmId);
        if (ACTION_SNOOZE.equals(action)) {
            AlarmPayload snoozed = AlarmStore.snooze(context, alarmId, System.currentTimeMillis() + SNOOZE_MINUTES * 60_000L);
            if (snoozed != null) AlarmScheduler.schedule(context, snoozed);
            if (snoozed != null) {
                AlarmActionSyncWorker.enqueue(
                    context,
                    alarmId,
                    "snooze",
                    SNOOZE_MINUTES,
                    snoozed.scheduledAtEpochMs,
                    snoozed.revision
                );
            }
            broadcast(context, alarmId, "snooze");
        } else if (ACTION_DISMISS.equals(action)) {
            AlarmPayload occurrence = AlarmStore.get(context, alarmId);
            long scheduledAtEpochMs = occurrence == null ? 0L : occurrence.scheduledAtEpochMs;
            AlarmScheduler.cancel(context, alarmId);
            AlarmPayload completed = AlarmStore.markCompleted(context, alarmId);
            if (completed != null) {
                AlarmActionSyncWorker.enqueue(context, alarmId, "dismiss", 0, scheduledAtEpochMs, completed.revision);
            }
            broadcast(context, alarmId, "dismiss");
        }
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(AlarmPayload.requestCode(alarmId));
    }

    static PendingIntent pending(Context context, AlarmPayload alarm, boolean snooze) {
        String action = snooze ? ACTION_SNOOZE : ACTION_DISMISS;
        Intent intent = new Intent(context, AlarmActionReceiver.class)
            .setAction(action)
            .setData(Uri.parse("autoai://alarm-action/" + Uri.encode(alarm.alarmId) + "/" + (snooze ? "snooze" : "dismiss")))
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.alarmId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, AlarmPayload.requestCode(alarm.alarmId) + (snooze ? 1 : 2), intent, flags);
    }

    static void cancelFromSync(Context context, String alarmId, boolean remove) {
        AlarmScheduler.cancel(context, alarmId);
        AlarmRingingService.stop(context, alarmId);
        if (remove) AlarmStore.remove(context, alarmId);
        broadcast(context, alarmId, remove ? "delete" : "cancel");
    }

    static void broadcast(Context context, String alarmId, String action) {
        context.sendBroadcast(new Intent(ACTION_CHANGED).setPackage(context.getPackageName())
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId)
            .putExtra(EXTRA_ACTION, action));
    }
}
