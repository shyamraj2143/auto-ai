package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Context;
import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.installations.FirebaseInstallations;
import com.google.firebase.messaging.FirebaseMessaging;

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
    public static final String ACTION_UI_READY = "com.autoai.app.call.UI_READY";
    private static final String ACTION_NATIVE_STATE = "com.autoai.app.call.NATIVE_STATE";
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
    private BroadcastReceiver nativeStateReceiver;

    @Override
    public void load() {
        nativeStateReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                JSObject payload = new JSObject();
                payload.put("callId", intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
                payload.put("state", intent.getStringExtra("state"));
                payload.put("errorCode", intent.getStringExtra("error_code"));
                notifyListeners("nativeCallState", payload);
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_NATIVE_STATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(nativeStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(nativeStateReceiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (nativeStateReceiver != null) {
            try { getContext().unregisterReceiver(nativeStateReceiver); }
            catch (IllegalArgumentException ignored) {}
            nativeStateReceiver = null;
        }
        super.handleOnDestroy();
    }

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
            FirebaseMessaging.getInstance().register().addOnCompleteListener(registrationTask -> {
                if (!registrationTask.isSuccessful()) {
                    Log.w(TAG, "FCM installation unavailable for call device registration.", registrationTask.getException());
                    call.resolve(result);
                    return;
                }
                FirebaseInstallations.getInstance().getId().addOnCompleteListener(fidTask -> {
                    String installationId = fidTask.isSuccessful() ? fidTask.getResult() : null;
                    if (installationId != null && !installationId.trim().isEmpty()) {
                        String cleanInstallationId = installationId.trim();
                        result.put("fcmToken", cleanInstallationId);
                        result.put("firebaseInstallationId", cleanInstallationId);
                        PushTokenRegistrar.registerInstallationAsync(getContext(), cleanInstallationId);
                        Log.i(TAG, "FCM direct-send installation available hash=" + PushTokenRegistrar.sha256Prefix(cleanInstallationId));
                    } else {
                        Log.w(TAG, "Firebase installation id unavailable for call device registration.", fidTask.getException());
                    }
                    call.resolve(result);
                });
            });
        } catch (RuntimeException error) {
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
        call.resolve(result);
    }

    @PluginMethod
    public void acknowledgeCallHandoff(PluginCall call) {
        String callId = call.getString("callId");
        if (callId == null || (!callId.equals(AcceptedCallHandoffStore.callId(getContext())) && !isActiveCall(getContext(), callId))) {
            call.reject("Accepted call handoff does not match.", "HANDOFF_MISMATCH");
            return;
        }
        AcceptedCallHandoffStore.setState(getContext(), callId, AcceptedCallHandoffStore.State.UI_READY);
        CallNotificationManager.clearPendingAction(getContext());
        AcceptedCallHandoffStore.clearTerminal(getContext(), callId);
        Log.i(TAG, "ACTIVE_CALL_UI_READY callId=" + callId);
        getContext().sendBroadcast(new Intent(ACTION_UI_READY).setPackage(getContext().getPackageName())
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId));
        call.resolve();
    }

    @PluginMethod
    public void getActiveCallState(PluginCall call) {
        ActiveCallStore.Snapshot snapshot = ActiveCallStore.get(getContext());
        JSObject result = new JSObject();
        if (snapshot != null) {
            result.put("callId", snapshot.callId);
            result.put("state", snapshot.state == null ? null : snapshot.state.name());
            result.put("errorCode", snapshot.lastErrorCode);
        }
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
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || isGranted("notifications")
                || isPermanentlyDenied("notifications")
                || CallingPermissionCoordinator.preferences(getContext()).getBoolean("notification_prompted", false)
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
        } catch (RuntimeException error) {
            Log.e(TAG, "Notification permission flow failed safely.", error);
            call.resolve(callPermissionsResult(false));
        }
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
        if (!isGranted("microphone")) {
            call.reject("Microphone permission is required.", "MICROPHONE_PERMISSION_DENIED");
            return;
        }
        if (video && !isGranted("camera")) {
            call.reject("Camera permission is required for video calling.", "CAMERA_PERMISSION_DENIED");
            return;
        }
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        intent.setAction(CallForegroundService.ACTION_START);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_CALLER_NAME, displayName);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_TYPE, video ? "video" : "audio");
        final String readyCallId = callId.trim();
        ActiveCallStore.Snapshot existingCall = ActiveCallStore.get(getContext(), readyCallId);
        if (existingCall == null) ActiveCallStore.startOutgoing(getContext(), readyCallId, video ? "video" : "audio", displayName);
        final Handler handler = new Handler(Looper.getMainLooper());
        final BroadcastReceiver receiver = new BroadcastReceiver() {
            private boolean completed;
            private void complete() {
                if (completed) return;
                completed = true;
                handler.removeCallbacksAndMessages(this);
                try { getContext().unregisterReceiver(this); } catch (IllegalArgumentException ignored) {}
            }
            @Override public void onReceive(Context context, Intent result) {
                if (!readyCallId.equals(result.getStringExtra(CallNotificationManager.EXTRA_CALL_ID))) return;
                String status = result.getStringExtra(CallForegroundService.EXTRA_SERVICE_STATUS);
                if (CallForegroundService.SERVICE_READY.equals(status)) {
                    complete();
                    CallIntentDispatcher.launchActive(getContext(), ActiveCallStore.get(getContext(), readyCallId));
                    call.resolve();
                } else if (CallForegroundService.SERVICE_FAILED.equals(status)) {
                    String code = result.getStringExtra(CallForegroundService.EXTRA_ERROR_CODE);
                    complete();
                    call.reject("Unable to start the call service.", code == null ? "INTERNAL_SERVICE_ERROR" : code);
                }
            }
        };
        IntentFilter filter = new IntentFilter(CallForegroundService.ACTION_SERVICE_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(receiver, filter);
        handler.postDelayed(() -> {
            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { return; }
            ActiveCallStore.Snapshot snapshot = ActiveCallStore.get(getContext(), readyCallId);
            if (snapshot != null && snapshot.isUsable()) {
                CallIntentDispatcher.launchActive(getContext(), snapshot);
                call.resolve();
                return;
            }
            CallNotificationManager.cancelOngoingCall(getContext(), readyCallId);
            call.reject("Call service readiness timed out.", "SERVICE_READY_TIMEOUT");
        }, 15_000L);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(intent);
            else getContext().startService(intent);
            Log.i(TAG, "Active call foreground service requested callId=" + callId + " presentation=app_owned");
        } catch (RuntimeException error) {
            try { getContext().unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
            Log.e(TAG, "Unable to start active call foreground service callId=" + callId, error);
            call.reject("Unable to start the call service.", error);
        }
    }

    @PluginMethod
    public void stopActiveCall(PluginCall call) {
        String callId = call.getString("callId");
        if (callId != null && !callId.trim().isEmpty()) AutoAiTelecomBridge.disconnectLocal(getContext(), callId);
        Intent stop = new Intent(getContext(), CallForegroundService.class).setAction(CallForegroundService.ACTION_STOP)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        getContext().startService(stop);
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
        if (NativeAudioRouter.routeForCall(audioManager, enabled, false)) call.resolve();
        else call.reject("Unable to change the audio route.", "AUDIO_ROUTE_FAILED");
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
        call.resolve(CallingPermissionCoordinator.inspect(getContext()).toJs(getContext()));
    }

    @PluginMethod
    public void getCallingSetupState(PluginCall call) {
        call.resolve(CallingPermissionCoordinator.inspect(getContext()).toJs(getContext()));
    }

    @PluginMethod
    public void refreshCallingSetupState(PluginCall call) {
        CallingPermissionCoordinator.invalidateCachedState();
        CallNotificationManager.createChannels(getContext());
        try { FirebaseMessaging.getInstance().register(); } catch (RuntimeException ignored) {}
        call.resolve(CallingPermissionCoordinator.inspect(getContext()).toJs(getContext()));
    }

    @PluginMethod
    public void startCallingSetup(PluginCall call) {
        Intent intent = new Intent(getContext(), CallingSetupActivity.class);
        getActivity().runOnUiThread(() -> {
            if (!CallingSetupActivity.isVisible() && !isAnyActiveCall(getContext())) getActivity().startActivity(intent);
            call.resolve();
        });
    }

    @PluginMethod
    public void openRequiredSetting(PluginCall call) {
        String item = call.getString("item", "app");
        try {
            getActivity().startActivity(CallingPermissionCoordinator.settingIntent(getContext(), item));
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Unable to open the required Android setting.", error);
        }
    }

    @PluginMethod
    public void openBackgroundActivitySettings(PluginCall call) {
        try {
            getActivity().startActivity(CallingPermissionCoordinator.backgroundActivitySettingsIntent(getContext()));
            call.resolve();
        } catch (RuntimeException error) {
            try {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                call.resolve();
            } catch (RuntimeException fallbackError) {
                call.reject("Unable to open Android background settings.", fallbackError);
            }
        }
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

    public static boolean isAnyActiveCall(Context context) {
        return context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE)
            .getString(KEY_ACTIVE_CALL_ID, null) != null;
    }

    public static boolean isActiveCall(Context context, String callId) {
        if (callId == null || callId.trim().isEmpty()) return false;
        SharedPreferences prefs = context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE);
        return callId.equals(prefs.getString(KEY_ACTIVE_CALL_ID, null));
    }

    public static String activeCallId(Context context) {
        return context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ACTIVE_CALL_ID, null);
    }

    public static String activeCallType(Context context) {
        return context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ACTIVE_CALL_TYPE, null);
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
        try {
            requestPermissionForAliases(aliases, call, "permissionCallback");
        } catch (RuntimeException error) {
            Log.e(TAG, "Capacitor permission request failed safely.", error);
            call.resolve(callPermissionsResult(Boolean.TRUE.equals(call.getBoolean("video", false))));
        }
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

    private String permissionName(String alias) {
        if ("microphone".equals(alias)) return Manifest.permission.RECORD_AUDIO;
        if ("camera".equals(alias)) return Manifest.permission.CAMERA;
        if ("notifications".equals(alias)) return Manifest.permission.POST_NOTIFICATIONS;
        if ("bluetoothConnect".equals(alias)) return Manifest.permission.BLUETOOTH_CONNECT;
        return null;
    }

    private boolean androidPermissionGranted(String alias) {
        String permission = permissionName(alias);
        if (permission == null) return false;
        if ("notifications".equals(alias) && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        if ("bluetoothConnect".equals(alias) && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        try {
            return getContext().checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to inspect Android permission safely: " + alias, error);
            return false;
        }
    }

    private boolean shouldShowPermissionRationale(String alias) {
        String permission = permissionName(alias);
        if (permission == null || getActivity() == null) return false;
        try {
            return getActivity().shouldShowRequestPermissionRationale(permission);
        } catch (RuntimeException error) {
            return false;
        }
    }

    private JSObject permissionResult(String alias, String requestedKey, boolean runtimeRequired) {
        boolean granted = !runtimeRequired || androidPermissionGranted(alias);
        boolean requested = permissions().getBoolean(requestedKey, false);
        boolean permanentlyDenied = runtimeRequired && requested && !granted && !shouldShowPermissionRationale(alias);
        JSObject result = new JSObject();
        result.put("state", granted ? "granted" : (permanentlyDenied ? "denied" : "prompt"));
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
        return androidPermissionGranted(alias);
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

    public static void saveActiveCall(Context context, String callId, String callType) {
        context.getSharedPreferences(ACTIVE_CALL_PREFERENCES, Context.MODE_PRIVATE).edit()
            .putString(KEY_ACTIVE_CALL_ID, callId)
            .putString(KEY_ACTIVE_CALL_TYPE, callType)
            .apply();
    }

    private SharedPreferences permissions() {
        return getContext().getSharedPreferences(PERMISSION_PREFERENCES, Context.MODE_PRIVATE);
    }
}
