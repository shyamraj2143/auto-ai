package com.autoai.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class UpdateScheduleReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            CallingPermissionCoordinator.preferences(context).edit()
                .putBoolean(CallingPermissionCoordinator.POST_UPDATE_CHECK, true)
                .apply();
            UpdateCheckScheduler.cancelLegacy(context);
        } else if (Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            UpdateCheckScheduler.cancelLegacy(context);
        }
    }
}
