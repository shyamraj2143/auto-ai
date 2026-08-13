package com.autoai.app;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;


@CapacitorPlugin(
    name = "AutoAiNotifications",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public final class AutoAiNotificationsPlugin extends Plugin {
    private static final String PREFS = "auto_ai_notification_permission";
    private static final String PROMPTED = "prompted";

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    /**
     * Use Android's native permission API here instead of Capacitor's
     * getPermissionState(). The latter can hit a null internal state on some
     * plugin registration combinations and crash the CapacitorPlugins thread.
     */
    private boolean granted() {
        return Build.VERSION.SDK_INT < 33
            || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject state() {
        boolean prompted = preferences().getBoolean(PROMPTED, false);
        boolean isGranted = granted();
        JSObject result = new JSObject();
        result.put("granted", isGranted);
        result.put("prompted", prompted);
        result.put("canPrompt", Build.VERSION.SDK_INT >= 33 && !isGranted && !prompted);
        result.put("settingsRequired", Build.VERSION.SDK_INT >= 33 && !isGranted && prompted);
        return result;
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (granted() || Build.VERSION.SDK_INT < 33) {
            call.resolve(state());
            return;
        }
        if (preferences().getBoolean(PROMPTED, false)) {
            call.resolve(state());
            return;
        }
        preferences().edit().putBoolean(PROMPTED, true).apply();
        requestPermissionForAlias("notifications", call, "notificationPermissionResult");
    }

    @PermissionCallback
    private void notificationPermissionResult(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve(state());
    }
}
