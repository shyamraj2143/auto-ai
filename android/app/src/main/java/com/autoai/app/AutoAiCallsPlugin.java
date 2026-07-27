package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.installations.FirebaseInstallations;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "AutoAiCalls",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
        @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera"),
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_CONNECT }, alias = "bluetoothConnect")
    }
)
public class AutoAiCallsPlugin extends Plugin {
    private static final String TAG = "AutoAiCalls";
    private static final String DEVICE_PREFERENCES = "auto_ai_call_device";
    private static final String FALLBACK_DEVICE_ID = "fallback_device_id";
    private static final String PERMISSION_PREFERENCES = "auto_ai_call_permissions";
    private static final String ACTIVE_CALL_PREFERENCES = "auto_ai_active_call";
    private static final String KEY_MIC_REQUESTED = "microphone_requested";
    private static final String KEY_CAMERA_REQUESTED = "camera_requested";
    private static final String KEY_NOTIFICATIONS_REQUESTED = "notifications_requested";
    private static final String KEY_BLUETOOTH_REQUESTED = "bluetooth_requested";
    private static final String KEY_ACTIVE_CALL_ID = "active_call_id";
    private static final String KEY_ACTIVE_CALL_TYPE = "active_call_type";

    @PluginMethod
    public void getDeviceRegistration(PluginCall call) {
        JSObject result = new JSObject();
        result.put("deviceId", resolveDeviceId());
        result.put("appVersion", BuildConfig.VERSION_NAME);
        result.put("appVersionCode", BuildConfig.VERSION_CODE);
        result.put("deviceName", PushTokenRegistrar.deviceName());
        result.put("firebaseConfigured", BuildConfig.AUTO_AI_FIREBASE_CONFIGURED);

        if (!BuildConfig.AUTO_AI_FIREBASE_CONFIGURED) {
            Log.w(TAG, "FCM registration skipped: google-services.json is not configured.");
            call.resolve(result);
            return;
        }

        try {
            FirebaseMessaging.getInstance().register().continueWithTask(ignored -> FirebaseInstallations.getInstance().getId()).addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null && !task.getResult().trim().isEmpty()) {
                    result.put("fcmToken", task.getResult());
                    result.put("firebaseInstallationId", task.getResult());
                    Log.i(TAG, "FCM installation identity available hash=" + PushTokenRegistrar.sha256Prefix(task.getResult()));
                } else {
                    Log.w(TAG, "FCM installation identity unavailable for call device registration.");
                }
                call.resolve(result);
            });
        } catch (RuntimeException error) {
            // Firebase is optional in builds without google-services.json.
            Log.w(TAG, "Firebase token lookup skipped.", error);
            call.resolve(result);
        }
    }

    private String resolveDeviceId() {
        return PushTokenRegistrar.deviceId(getContext(), DEVICE_PREFERENCES, FALLBACK_DEVICE_ID);
    }

    @PluginMethod
    public void consumeIncomingCall(PluginCall call) {
        Context context = getContext();
        String callId = CallNotificationManager.pendingCallId(context);
        String action = CallNotificationManager.pendingAction(context);
        JSObject result = new JSObject();
        result.put("callId", callId);
        result.put("action", action);
        CallNotificationManager.clearPendingAction(context);
        call.resolve(result);
    }

    @PluginMethod
    public void checkCallPermissions(PluginCall call) {
        call.resolve(callPermissionsResult(Boolean.TRUE.equals(call.getBoolean("video", false))));
    }

    @PluginMethod
    public void requestAudioCallPermissions(PluginCall call) {
        if (isGranted("microphone") || isPermanentlyDenied("microphone")) {
            call.resolve(callPermissionsResult(false));
            return;
        }
        requestPermissionAliases(call, new String[] { "microphone" }, new String[] { KEY_MIC_REQUESTED });
    }

    @PluginMethod
    public void requestVideoCallPermissions(PluginCall call) {
        List<String> aliases = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        if (!isGranted("microphone")) {
            aliases.add("microphone");
            keys.add(KEY_MIC_REQUESTED);
        }
        if (!isGranted("camera")) {
            aliases.add("camera");
            keys.add(KEY_CAMERA_REQUESTED);
        }
        if (aliases.isEmpty() || isPermanentlyDenied("microphone") || isPermanentlyDenied("camera")) {
            call.resolve(callPermissionsResult(true));
            return;
        }
        requestPermissionAliases(call, aliases.toArray(new String[0]), keys.toArray(new String[0]));
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || isGranted("notifications")
            || isPermanentlyDenied("notifications")
            || permissions().getBoolean(KEY_NOTIFICATIONS_REQUESTED, false)) {
            call.resolve(callPermissionsResult(false));
            return;
        }
        getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
            .setTitle("Allow call notifications")
            .setMessage("Auto-AI needs notifications so calls and messages can appear when the app is in the background. If denied, incoming calls and messages may not appear until you open the app.")
            .setNegativeButton("Not now", (dialog, which) -> call.resolve(callPermissionsResult(false)))
            .setPositiveButton("Continue", (dialog, which) -> requestPermissionAliases(call, new String[] { "notifications" }, new String[] { KEY_NOTIFICATIONS_REQUESTED }))
            .show());
    }

    @PluginMethod
    public void requestBluetoothConnectPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || isGranted("bluetoothConnect") || isPermanentlyDenied("bluetoothConnect")) {
            call.resolve(callPermissionsResult(false));
            return;
        }
        requestPermissionAliases(call, new String[] { "bluetoothConnect" }, new String[] { KEY_BLUETOOTH_REQUESTED });
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        call.resolve(callPermissionsResult(Boolean.TRUE.equals(call.getBoolean("video", false))));
    }

    @PluginMethod
    public void startActiveCall(PluginCall call) {
        String callId = call.getString("callId");
        String displayName = call.getString("displayName", "Auto-AI call");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        if (callId == null || callId.trim().isEmpty()) {
            call.reject("Call id is required.");
            return;
        }
        if (!hasRequiredCallPermissions(video)) {
            call.reject("Required call permissions are missing.", "CALL_PERMISSION_REQUIRED");
            return;
        }
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        intent.setAction(CallForegroundService.ACTION_START);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_CALLER_NAME, displayName);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_TYPE, video ? "video" : "audio");
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            AutoAiTelecomBridge.reportOutgoingCall(getContext(), callId, displayName, video ? "video" : "audio");
            saveActiveCall(getContext(), callId, video ? "video" : "audio");
            Log.i(TAG, "Active call foreground service requested callId=" + callId);
            call.resolve();
        } catch (RuntimeException error) {
            Log.e(TAG, "Unable to start active call foreground service callId=" + callId, error);
            call.reject("Unable to start the call service.", error);
        }
    }

    @PluginMethod
    public void stopActiveCall(PluginCall call) {
        String callId = call.getString("callId");
        if (callId != null && !callId.trim().isEmpty()) AutoAiTelecomBridge.disconnectLocal(getContext(), callId);
        getContext().stopService(new Intent(getContext(), CallForegroundService.class));
        clearActiveCall(getContext(), callId);
        call.resolve();
    }

    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            call.reject("Audio routing is unavailable.");
            return;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audioManager.setSpeakerphoneOn(enabled);
        call.resolve();
    }

    @PluginMethod
    public void setAudioRoute(PluginCall call) {
        String route = call.getString("route", "");
        AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) {
            call.reject("Audio routing is unavailable.");
            return;
        }
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        try {
            if ("speaker".equals(route)) {
                setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER);
                audioManager.setSpeakerphoneOn(true);
            } else if ("earpiece".equals(route)) {
                setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE);
                audioManager.setSpeakerphoneOn(false);
            } else if ("wired".equals(route)) {
                if (!setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_WIRED_HEADSET)) {
                    call.reject("No wired headset route is available.", "AUDIO_ROUTE_UNAVAILABLE");
                    return;
                }
            } else if ("bluetooth".equals(route)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !isGranted("bluetoothConnect")) {
                    call.reject("Bluetooth audio permission is required.", "BLUETOOTH_CONNECT_REQUIRED");
                    return;
                }
                if (!setBluetoothRoute(audioManager)) {
                    call.reject("No paired Bluetooth call route is available.", "AUDIO_ROUTE_UNAVAILABLE");
                    return;
                }
            } else {
                call.reject("Unsupported audio route.", "AUDIO_ROUTE_UNSUPPORTED");
                return;
            }
            call.resolve();
        } catch (SecurityException error) {
            call.reject("Audio route permission was denied.", "AUDIO_ROUTE_PERMISSION_DENIED", error);
        } catch (RuntimeException error) {
            call.reject("Unable to change audio route.", "AUDIO_ROUTE_FAILED", error);
        }
    }

    @PluginMethod
    public void checkFullScreenIntentPermission(PluginCall call) {
        JSObject result = new JSObject();
        result.put("required", Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE);
        result.put("granted", canUseFullScreenIntent());
        call.resolve(result);
    }

    @PluginMethod
    public void getCallReadiness(PluginCall call) {
        Context context = getContext();
        CallNotificationManager.createChannels(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null
            ? manager.getNotificationChannel(CallNotificationManager.CHANNEL_INCOMING) : null;
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean notificationsAllowed = manager != null && manager.areNotificationsEnabled()
            && (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED);
        int importance = channel == null ? (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ? NotificationManager.IMPORTANCE_HIGH : NotificationManager.IMPORTANCE_NONE) : channel.getImportance();
        boolean channelReady = importance >= NotificationManager.IMPORTANCE_HIGH;
        boolean fullScreen = canUseFullScreenIntent();
        JSObject result = new JSObject();
        result.put("status", !notificationsAllowed || !channelReady ? "BLOCKED" : fullScreen ? "READY" : "LIMITED");
        result.put("sdkVersion", Build.VERSION.SDK_INT);
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("model", Build.MODEL);
        result.put("appVersion", BuildConfig.VERSION_NAME);
        result.put("appVersionCode", BuildConfig.VERSION_CODE);
        result.put("firebaseTokenRegistered", PushTokenRegistrar.hasStoredToken(context));
        result.put("notificationsAllowed", notificationsAllowed);
        result.put("channelExists", channel != null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O);
        result.put("channelImportance", importance);
        result.put("channelSoundEnabled", channel == null || channel.getSound() != null);
        result.put("channelVibrationEnabled", channel == null || channel.shouldVibrate());
        result.put("lockscreenVisibility", channel == null ? NotificationManager.IMPORTANCE_UNSPECIFIED : channel.getLockscreenVisibility());
        result.put("fullScreenIntentAllowed", fullScreen);
        result.put("batteryOptimizationIgnored", power != null && power.isIgnoringBatteryOptimizations(context.getPackageName()));
        result.put("microphoneAllowed", context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        result.put("cameraAllowed", context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED);
        call.resolve(result);
    }

    @PluginMethod
    public void openIncomingCallChannelSettings(PluginCall call) {
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
                .putExtra(Settings.EXTRA_CHANNEL_ID, CallNotificationManager.CHANNEL_INCOMING)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(intent); }
        catch (RuntimeException error) { openAppSettings(call); return; }
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openAppNotificationSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT)
                .setData(Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
        } catch (RuntimeException error) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallback);
        }
        call.resolve();
    }

    public static boolean isActiveVideoCall(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE);
        return prefs.getString(KEY_ACTIVE_CALL_ID, null) != null && "video".equals(prefs.getString(KEY_ACTIVE_CALL_TYPE, null));
    }

    public static boolean isActiveCall(Context context, String callId) {
        if (callId == null || callId.trim().isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE);
        return callId.equals(prefs.getString(KEY_ACTIVE_CALL_ID, null));
    }

    public static void clearActiveCall(Context context, String callId) {
        SharedPreferences prefs = context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE);
        String activeCallId = prefs.getString(KEY_ACTIVE_CALL_ID, null);
        if (callId == null || callId.trim().isEmpty() || callId.equals(activeCallId)) {
            prefs.edit().clear().apply();
            clearCommunicationDevice(context);
        }
    }

    private void requestPermissionAliases(PluginCall call, String[] aliases, String[] requestedKeys) {
        if (aliases.length == 0) {
            call.resolve(callPermissionsResult(Boolean.TRUE.equals(call.getBoolean("video", false))));
            return;
        }
        for (String key : requestedKeys) permissions().edit().putBoolean(key, true).apply();
        requestPermissionForAliases(aliases, call, "permissionCallback");
    }

    private JSObject callPermissionsResult(boolean video) {
        JSObject result = new JSObject();
        JSObject microphone = permissionResult("microphone", KEY_MIC_REQUESTED, true);
        JSObject camera = permissionResult("camera", KEY_CAMERA_REQUESTED, true);
        JSObject notifications = permissionResult("notifications", KEY_NOTIFICATIONS_REQUESTED, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        JSObject bluetooth = permissionResult("bluetoothConnect", KEY_BLUETOOTH_REQUESTED, Build.VERSION.SDK_INT >= Build.VERSION_CODES.S);
        boolean microphoneGranted = microphone.getBool("granted");
        boolean cameraGranted = camera.getBool("granted");
        boolean audioGranted = microphoneGranted;
        boolean videoGranted = microphoneGranted && cameraGranted;
        JSONArray missing = new JSONArray();
        if (!microphoneGranted) missing.put("microphone");
        if (video && !cameraGranted) missing.put("camera");
        result.put("microphone", microphone);
        result.put("camera", camera);
        result.put("notifications", notifications);
        result.put("bluetoothConnect", bluetooth);
        result.put("canStartAudioCall", audioGranted);
        result.put("canStartVideoCall", videoGranted);
        result.put("granted", video ? videoGranted : audioGranted);
        result.put("missing", missing);
        result.put("requiresSettings", microphone.getBool("permanentlyDenied") || (video && camera.getBool("permanentlyDenied")));
        return result;
    }

    private JSObject permissionResult(String alias, String requestedKey, boolean runtimeRequired) {
        PermissionState state = runtimeRequired ? getPermissionState(alias) : PermissionState.GRANTED;
        if (state == null) state = PermissionState.PROMPT;
        boolean granted = !runtimeRequired || state == PermissionState.GRANTED;
        boolean requested = permissions().getBoolean(requestedKey, false);
        boolean permanentlyDenied = runtimeRequired && requested && state == PermissionState.DENIED;
        JSObject result = new JSObject();
        result.put("state", granted ? "granted" : state.toString());
        result.put("granted", granted);
        result.put("permanentlyDenied", permanentlyDenied);
        result.put("canAskAgain", runtimeRequired && !granted && !permanentlyDenied);
        result.put("required", runtimeRequired);
        return result;
    }

    private boolean hasRequiredCallPermissions(boolean video) {
        return getContext().checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            && (!video || getContext().checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED);
    }

    private boolean isGranted(String alias) {
        PermissionState state = getPermissionState(alias);
        return state == PermissionState.GRANTED;
    }

    private boolean isPermanentlyDenied(String alias) {
        if ("microphone".equals(alias)) return permissionResult(alias, KEY_MIC_REQUESTED, true).getBool("permanentlyDenied");
        if ("camera".equals(alias)) return permissionResult(alias, KEY_CAMERA_REQUESTED, true).getBool("permanentlyDenied");
        if ("notifications".equals(alias)) return permissionResult(alias, KEY_NOTIFICATIONS_REQUESTED, Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU).getBool("permanentlyDenied");
        if ("bluetoothConnect".equals(alias)) return permissionResult(alias, KEY_BLUETOOTH_REQUESTED, Build.VERSION.SDK_INT >= Build.VERSION_CODES.S).getBool("permanentlyDenied");
        return false;
    }

    private boolean canUseFullScreenIntent() {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            || (manager != null && manager.canUseFullScreenIntent());
    }

    private boolean setBluetoothRoute(AudioManager audioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
                || setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_BLE_HEADSET)
                || setCommunicationRoute(audioManager, AudioDeviceInfo.TYPE_HEARING_AID);
        }
        audioManager.startBluetoothSco();
        audioManager.setBluetoothScoOn(true);
        return true;
    }

    private boolean setCommunicationRoute(AudioManager audioManager, int deviceType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        for (AudioDeviceInfo device : audioManager.getAvailableCommunicationDevices()) {
            if (device.getType() == deviceType) {
                return audioManager.setCommunicationDevice(device);
            }
        }
        return false;
    }

    private static void clearCommunicationDevice(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        AudioManager audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (audioManager != null) audioManager.clearCommunicationDevice();
    }

    private void saveActiveCall(Context context, String callId, String callType) {
        context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(KEY_ACTIVE_CALL_ID, callId)
            .putString(KEY_ACTIVE_CALL_TYPE, callType)
            .apply();
    }

    private SharedPreferences permissions() {
        return getContext().getSharedPreferences(PERMISSION_PREFERENCES, Context.MODE_PRIVATE);
    }
}
