package com.autoai.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

/** Routes WebRTC playout through Android's communication-device API when available. */
final class NativeAudioRouter {
    private static final String TAG = "AutoAiAudioRoute";

    private NativeAudioRouter() {}

    static boolean routeForCall(Context context, boolean speaker, boolean preserveExternalRoute) {
        AudioManager manager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        return manager != null && routeForCall(manager, speaker, preserveExternalRoute);
    }

    static boolean routeForCall(AudioManager manager, boolean speaker, boolean preserveExternalRoute) {
        try {
            manager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo current = manager.getCommunicationDevice();
                if (preserveExternalRoute && isExternalCallDevice(current)) return true;
                int targetType = speaker
                    ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices()) {
                    if (device.getType() == targetType && manager.setCommunicationDevice(device)) {
                        Log.i(TAG, "Communication device selected type=" + targetType);
                        return true;
                    }
                }
            }
            manager.setSpeakerphoneOn(speaker);
            return true;
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to select communication route.", error);
            return false;
        }
    }

    static void clear(AudioManager manager) {
        if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        try { manager.clearCommunicationDevice(); }
        catch (RuntimeException error) { Log.w(TAG, "Unable to clear communication route.", error); }
    }

    private static boolean isExternalCallDevice(AudioDeviceInfo device) {
        if (device == null) return false;
        int type = device.getType();
        return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            || type == AudioDeviceInfo.TYPE_BLE_HEADSET
            || type == AudioDeviceInfo.TYPE_HEARING_AID
            || type == AudioDeviceInfo.TYPE_WIRED_HEADSET
            || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
            || type == AudioDeviceInfo.TYPE_USB_DEVICE
            || type == AudioDeviceInfo.TYPE_USB_HEADSET
            || type == AudioDeviceInfo.TYPE_USB_ACCESSORY;
    }
}
