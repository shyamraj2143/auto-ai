package com.autoai.app;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
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

    private boolean granted() {
        return Build.VERSION.SDK_INT < 33
            || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }

    private JSObject state() {
        boolean prompted = preferences().getBoolean(PROMPTED, false);
        JSObject result = new JSObject();
        result.put("granted", granted());
        result.put("prompted", prompted);
        result.put("canPrompt", Build.VERSION.SDK_INT >= 33 && !granted());
        result.put("settingsRequired", Build.VERSION.SDK_INT >= 33 && !granted() && prompted);
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
        // Do not permanently block retries because the first prompt can be lost
        // during WebView startup or dismissed before the user sees it.
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
