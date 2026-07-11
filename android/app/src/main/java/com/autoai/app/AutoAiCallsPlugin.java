package com.autoai.app;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.messaging.FirebaseMessaging;

@CapacitorPlugin(name = "AutoAiCalls")
public class AutoAiCallsPlugin extends Plugin {
    private static final String TAG = "AutoAiCalls";
    private static final String DEVICE_PREFERENCES = "auto_ai_call_device";
    private static final String FALLBACK_DEVICE_ID = "fallback_device_id";

    @PluginMethod
    public void getDeviceRegistration(PluginCall call) {
        JSObject result = new JSObject();
        result.put("deviceId", resolveDeviceId());
        result.put("appVersion", BuildConfig.VERSION_NAME);
        result.put("appVersionCode", BuildConfig.VERSION_CODE);
        result.put("deviceName", PushTokenRegistrar.deviceName());

        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null && !task.getResult().trim().isEmpty()) {
                    result.put("fcmToken", task.getResult());
                    Log.i(TAG, "FCM registration token available for call device registration.");
                } else {
                    Log.w(TAG, "FCM registration token unavailable for call device registration.");
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
    public void startActiveCall(PluginCall call) {
        String callId = call.getString("callId");
        String displayName = call.getString("displayName", "Auto-AI call");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        if (callId == null || callId.trim().isEmpty()) {
            call.reject("Call id is required.");
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
            Log.i(TAG, "Active call foreground service requested callId=" + callId);
            call.resolve();
        } catch (RuntimeException error) {
            Log.e(TAG, "Unable to start active call foreground service callId=" + callId, error);
            call.reject("Unable to start the call service.", error);
        }
    }

    @PluginMethod
    public void stopActiveCall(PluginCall call) {
        getContext().stopService(new Intent(getContext(), CallForegroundService.class));
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
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}
