package com.autoai.app;

import android.app.Application;
import android.util.Log;

import com.google.firebase.FirebaseApp;

/** Keeps optional integrations from crashing the app before Capacitor starts. */
public final class AutoAiApplication extends Application {
    private static final String TAG = "AutoAiApplication";

    @Override public void onCreate() {
        super.onCreate();
        runStartupStep("notification channels", () -> CallNotificationManager.createChannels(this));
        runStartupStep("alarm channel", () -> AlarmRingingService.createChannel(this));
        runStartupStep("alarm restore", () -> AlarmScheduler.rescheduleAll(this));
        runStartupStep("update coordinator", () -> AppUpdateCoordinator.get(this));
        runStartupStep("telecom registration", () -> {
            TelecomRegistrationResult result = AutoAiTelecomBridge.ensureRegisteredDetailed(this);
            Log.i(TAG, "Telecom startup registration result=" + result.name());
        });
        runStartupStep("firebase", () -> {
            if (FirebaseApp.getApps(this).isEmpty()) FirebaseApp.initializeApp(this);
            FcmInstallationMigrationWorker.schedule(this);
            Log.i(TAG, "Firebase initialized=" + !FirebaseApp.getApps(this).isEmpty());
        });
    }

    private void runStartupStep(String name, StartupStep step) {
        try {
            step.run();
        } catch (Throwable error) {
            Log.e(TAG, "Non-fatal startup failure in " + name, error);
        }
    }

    @FunctionalInterface
    private interface StartupStep { void run() throws Exception; }
}
