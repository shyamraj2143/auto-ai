package com.autoai.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;

final class CallFailureMessages {
    private CallFailureMessages() {}

    static boolean isOnline(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network network = manager.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    static String message(Context context, String code) {
        if (!isOnline(context) || "NETWORK_LOST".equals(code)) {
            return "No internet connection. Turn on mobile data or Wi-Fi, then retry.";
        }
        if (code == null) return "AutoAI could not prepare the call. Please retry.";
        switch (code) {
            case "MICROPHONE_PERMISSION_DENIED":
            case "CALL_PERMISSION_REQUIRED":
                return "Microphone permission is required. Allow it in Android Settings, then retry.";
            case "CAMERA_PERMISSION_DENIED":
                return "Camera permission is required for video. Allow it, or answer using audio only.";
            case "FOREGROUND_SERVICE_PERMISSION_DENIED":
                return "Android blocked a required calling permission. Allow microphone and camera access, then retry.";
            case "FOREGROUND_SERVICE_START_NOT_ALLOWED":
                return "Android blocked the call service. Keep AutoAI visible and allow background activity, then retry.";
            case "FOREGROUND_SERVICE_TYPE_MISSING":
                return "This AutoAI build has an invalid calling-service configuration. Install the latest update.";
            case "FOREGROUND_NOTIFICATION_FAILED":
                return "Call notifications are blocked. Allow AutoAI call notifications, then retry.";
            case "SERVICE_READY_TIMEOUT":
            case "FOREGROUND_SERVICE_TIMEOUT":
                return "The Android calling service timed out. Close this screen and retry once.";
            case "SIGNALING_AUTH_FAILED":
                return "The secure call session expired. Reopen AutoAI and retry.";
            case "SIGNALING_TIMEOUT":
            case "OFFER_NOT_RECEIVED":
                return "Secure call signaling is unavailable. Check the network and retry.";
            case "TURN_AUTH_FAILED":
            case "TURN_UNREACHABLE":
                return "The call relay is unavailable. Change between Wi-Fi and mobile data, then retry.";
            case "ICE_CONNECTION_FAILED":
            case "MEDIA_CONNECT_TIMEOUT":
                return "Audio or video could not connect. Retry on a stable network.";
            case "BACKEND_ACCEPT_FAILED":
                return "The server could not accept this call. Check the network and retry before it expires.";
            case "CALL_STATE_CONFLICT":
                return "This call has already ended or was answered on another device.";
            case "AUDIO_FOCUS_FAILED":
                return "Another app is using call audio. Close the other call or recorder, then retry.";
            default:
                return "AutoAI could not prepare the call. Please retry. Error: " + code;
        }
    }
}
