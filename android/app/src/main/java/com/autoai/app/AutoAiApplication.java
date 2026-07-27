package com.autoai.app;

import android.app.Application;
import android.util.Log;

import com.google.firebase.FirebaseApp;

public final class AutoAiApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        CallNotificationManager.createChannels(this);
        AppUpdateCoordinator.get(this);
        try {
            if (FirebaseApp.getApps(this).isEmpty()) FirebaseApp.initializeApp(this);
            Log.i("AutoAiApplication", "Call infrastructure initialized firebase=" + !FirebaseApp.getApps(this).isEmpty());
        } catch (RuntimeException error) {
            Log.w("AutoAiApplication", "Firebase initialization unavailable", error);
        }
    }
}
