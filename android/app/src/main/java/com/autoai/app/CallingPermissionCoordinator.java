package com.autoai.app;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.getcapacitor.JSObject;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** The authoritative, side-effect-free snapshot of Android calling setup. */
public final class CallingPermissionCoordinator {
    static final List<String> USER_PERMISSION_KEYS = java.util.Arrays.asList(
        "notifications", "incomingChannel", "microphone", "camera", "bluetooth", "fullScreen", "backgroundActivity"
    );
    public static final String PREFS = "auto_ai_permission_onboarding";
    public static final String LAST_COMPLETED_VERSION = "last_completed_version_code";
    public static final String POST_UPDATE_CHECK = "post_update_permission_check_required";
    public static final String ONBOARDING_STARTED = "onboarding_started";
    public static final String ONBOARDING_COMPLETED = "onboarding_completed";
    public static final String LAST_STATUS = "last_readiness_status";

    public enum Status { READY, LIMITED, BLOCKED }
    public enum ItemState { GRANTED, LIMITED, NOT_REQUIRED, PROMPT_AVAILABLE, DENIED, PERMANENTLY_DENIED, SPECIAL_ACCESS_REQUIRED, CHANNEL_DISABLED, UNAVAILABLE }
    public enum DiagnosticState { READY, UNAVAILABLE, MISCONFIGURED, UNKNOWN }

    public static final class Snapshot {
        public final Status permissionStatus;
        public final Map<String, ItemState> permissionItems;
        public final Map<String, DiagnosticState> internalDiagnostics;
        public final boolean systemReady;

        Snapshot(Status permissionStatus, Map<String, ItemState> permissionItems, Map<String, DiagnosticState> internalDiagnostics) {
            this.permissionStatus = permissionStatus;
            this.permissionItems = permissionItems;
            this.internalDiagnostics = internalDiagnostics;
            this.systemReady = internalDiagnostics.values().stream().allMatch(value -> value == DiagnosticState.READY);
        }

        public JSObject toJs(Context context) {
            JSObject out = new JSObject();
            JSObject values = new JSObject();
            for (Map.Entry<String, ItemState> item : permissionItems.entrySet()) {
                JSObject value = new JSObject();
                value.put("state", item.getValue().name());
                values.put(item.getKey(), value);
            }
            SharedPreferences prefs = preferences(context);
            out.put("status", permissionStatus.name());
            out.put("versionCode", BuildConfig.VERSION_CODE);
            out.put("onboardingCompleted", prefs.getInt(LAST_COMPLETED_VERSION, -1) == BuildConfig.VERSION_CODE);
            out.put("items", values);
            return out;
        }
    }

    private CallingPermissionCoordinator() {}

    public static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static Snapshot inspect(Context context) {
        CallNotificationManager.createChannels(context);
        Map<String, ItemState> permissionItems = new LinkedHashMap<>();
        Map<String, DiagnosticState> diagnostics = new LinkedHashMap<>();
        NotificationManager notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean runtimeNotifications = Build.VERSION.SDK_INT >= 33;
        boolean notificationGranted = !runtimeNotifications || granted(context, Manifest.permission.POST_NOTIFICATIONS);
        permissionItems.put("notifications", permissionState(context, Manifest.permission.POST_NOTIFICATIONS, "notification_prompted", runtimeNotifications));
        if (notificationGranted && (notifications == null || !notifications.areNotificationsEnabled())) permissionItems.put("notifications", ItemState.DENIED);

        NotificationChannel channel = Build.VERSION.SDK_INT >= 26 && notifications != null
            ? notifications.getNotificationChannel(CallNotificationManager.CHANNEL_INCOMING) : null;
        if (Build.VERSION.SDK_INT < 26) permissionItems.put("incomingChannel", ItemState.NOT_REQUIRED);
        else if (channel == null || channel.getImportance() < NotificationManager.IMPORTANCE_HIGH || channel.getSound() == null || !channel.shouldVibrate())
            permissionItems.put("incomingChannel", ItemState.CHANNEL_DISABLED);
        else permissionItems.put("incomingChannel", ItemState.GRANTED);

        permissionItems.put("microphone", permissionState(context, Manifest.permission.RECORD_AUDIO, "microphone_prompted", true));
        permissionItems.put("camera", permissionState(context, Manifest.permission.CAMERA, "camera_prompted", true));
        permissionItems.put("bluetooth", permissionState(context, Manifest.permission.BLUETOOTH_CONNECT, "bluetooth_prompted", Build.VERSION.SDK_INT >= 31));

        boolean fullScreen = Build.VERSION.SDK_INT < 34 || (notifications != null && notifications.canUseFullScreenIntent());
        permissionItems.put("fullScreen", fullScreen ? ItemState.GRANTED : ItemState.SPECIAL_ACCESS_REQUIRED);
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        ActivityManager activity = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        boolean backgroundRestricted = Build.VERSION.SDK_INT >= 28 && activity != null && activity.isBackgroundRestricted();
        boolean batteryAllowlisted = power != null && power.isIgnoringBatteryOptimizations(context.getPackageName());
        permissionItems.put("backgroundActivity", backgroundState(backgroundRestricted, batteryAllowlisted));

        boolean playServices = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS;
        diagnostics.put("playServices", playServices ? DiagnosticState.READY : DiagnosticState.UNAVAILABLE);
        boolean pushRegistration = BuildConfig.AUTO_AI_FIREBASE_CONFIGURED && PushTokenRegistrar.hasStoredToken(context);
        diagnostics.put("pushRegistration", pushRegistration ? DiagnosticState.READY : DiagnosticState.UNAVAILABLE);
        diagnostics.put("foregroundServiceConfiguration", hasCallForegroundService(context) ? DiagnosticState.READY : DiagnosticState.MISCONFIGURED);
        diagnostics.put("telecomRegistration", telecomRegistered(context) ? DiagnosticState.READY : DiagnosticState.UNAVAILABLE);
        diagnostics.put("powerSaveMode", power == null ? DiagnosticState.UNKNOWN : power.isPowerSaveMode() ? DiagnosticState.UNAVAILABLE : DiagnosticState.READY);

        Status status = readinessFor(permissionItems);
        preferences(context).edit().putString(LAST_STATUS, status.name()).apply();
        return new Snapshot(status, permissionItems, diagnostics);
    }

    public static boolean needsOnboarding(Context context) {
        SharedPreferences prefs = preferences(context);
        return shouldOnboard(prefs.getInt(LAST_COMPLETED_VERSION, -1), BuildConfig.VERSION_CODE, prefs.getBoolean(POST_UPDATE_CHECK, false));
    }

    static boolean shouldOnboard(int completedVersion, int currentVersion, boolean postUpdate) {
        return completedVersion < currentVersion || postUpdate;
    }

    static boolean runtimeNotificationRequired(int sdk) { return sdk >= 33; }
    static boolean runtimeBluetoothRequired(int sdk) { return sdk >= 31; }

    static Status readinessFor(Map<String, ItemState> items) {
        boolean blocked = !isReady(items.get("notifications")) || !isReady(items.get("incomingChannel"))
            || !isReady(items.get("microphone")) || isBlocked(items.get("backgroundActivity"));
        boolean limited = !isReady(items.get("camera")) || !isReady(items.get("bluetooth"))
            || !isReady(items.get("fullScreen")) || items.get("backgroundActivity") == ItemState.LIMITED;
        return blocked ? Status.BLOCKED : limited ? Status.LIMITED : Status.READY;
    }

    static ItemState backgroundState(boolean backgroundRestricted, boolean batteryAllowlisted) {
        if (backgroundRestricted) return ItemState.DENIED;
        return batteryAllowlisted ? ItemState.GRANTED : ItemState.LIMITED;
    }

    public static void invalidateCachedState() {
        // Snapshots are intentionally never cached; every inspection reads current platform state.
    }

    public static void completeCurrentVersion(Context context) {
        Snapshot snapshot = inspect(context);
        preferences(context).edit().putInt(LAST_COMPLETED_VERSION, BuildConfig.VERSION_CODE)
            .putBoolean(ONBOARDING_COMPLETED, true).putBoolean(POST_UPDATE_CHECK, false)
            .putString(LAST_STATUS, snapshot.permissionStatus.name()).apply();
    }

    public static Intent settingIntent(Context context, String item) {
        Intent intent;
        if ("incomingChannel".equals(item) && Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CallNotificationManager.CHANNEL_INCOMING);
        } else if ("notifications".equals(item) && Build.VERSION.SDK_INT >= 26) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        } else if ("fullScreen".equals(item) && Build.VERSION.SDK_INT >= 34) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + context.getPackageName()));
        } else if ("backgroundActivity".equals(item)) {
            intent = backgroundActivitySettingsIntent(context);
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
        }
        return intent;
    }

    public static Intent backgroundActivitySettingsIntent(Context context) {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.getPackageName()));
    }

    private static ItemState permissionState(Context context, String permission, String promptedKey, boolean required) {
        if (!required) return ItemState.NOT_REQUIRED;
        if (granted(context, permission)) return ItemState.GRANTED;
        boolean prompted = preferences(context).getBoolean(promptedKey, false);
        if (!prompted) return ItemState.PROMPT_AVAILABLE;
        if (context instanceof Activity && !((Activity) context).shouldShowRequestPermissionRationale(permission)) return ItemState.PERMANENTLY_DENIED;
        return ItemState.DENIED;
    }

    private static boolean granted(Context context, String permission) { return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED; }
    private static boolean isReady(ItemState state) { return state == ItemState.GRANTED || state == ItemState.NOT_REQUIRED; }
    private static boolean isBlocked(ItemState state) { return state == ItemState.DENIED || state == ItemState.PERMANENTLY_DENIED || state == ItemState.CHANNEL_DISABLED || state == ItemState.UNAVAILABLE; }

    private static boolean hasCallForegroundService(Context context) {
        try {
            ServiceInfo info = context.getPackageManager().getServiceInfo(new ComponentName(context, CallForegroundService.class), PackageManager.ComponentInfoFlags.of(0));
            if (Build.VERSION.SDK_INT < 29) return true;
            int required = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            return (info.getForegroundServiceType() & required) == required;
        } catch (Exception ignored) { return false; }
    }

    private static boolean telecomRegistered(Context context) {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            TelecomManager manager = (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
            PhoneAccountHandle handle = new PhoneAccountHandle(new ComponentName(context, AutoAiConnectionService.class), "auto_ai_self_managed_calls");
            return manager != null && manager.getPhoneAccount(handle) != null;
        } catch (RuntimeException ignored) { return false; }
    }
}
