package com.autoai.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class AutoAiTelecomBridge {
    static final String EXTRA_CALL_ID = "auto_ai_call_id";
    static final String EXTRA_CALLER_NAME = "auto_ai_caller_name";
    static final String EXTRA_CALL_TYPE = "auto_ai_call_type";
    static final String EXTRA_EXPIRES_AT = "auto_ai_expires_at";

    private static final String TAG = "AutoAiTelecom";
    private static final String ACCOUNT_ID = "auto_ai_self_managed_calls";
    private static final Map<String, AutoAiCallConnection> CONNECTIONS = new ConcurrentHashMap<>();

    private AutoAiTelecomBridge() {}

    public static boolean reportIncomingCall(Context context, Map<String, String> data) {
        if (!isAvailable(context)) return false;
        String callId = clean(data.get("call_id"));
        String callType = clean(data.get("call_type"));
        if (callId == null || (!"audio".equals(callType) && !"video".equals(callType))) return false;
        try {
            TelecomManager telecom = telecom(context);
            if (telecom == null) return false;
            PhoneAccountHandle handle = ensurePhoneAccount(context);
            Bundle callExtras = callExtras(
                callId,
                clean(data.get("caller_name")),
                callType,
                parseLong(data.get("expires_at_epoch_ms"))
            );
            Bundle extras = new Bundle(callExtras);
            extras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callExtras);
            telecom.addNewIncomingCall(handle, extras);
            Log.i(TAG, "Reported incoming call to Telecom callId=" + callId);
            return true;
        } catch (RuntimeException error) {
            Log.w(TAG, "Telecom incoming call report failed callId=" + callId, error);
            return false;
        }
    }

    public static void reportOutgoingCall(Context context, String callId, String displayName, String callType) {
        if (!isAvailable(context) || clean(callId) == null) return;
        if (context.checkSelfPermission(Manifest.permission.MANAGE_OWN_CALLS) != PackageManager.PERMISSION_GRANTED) return;
        AutoAiCallConnection existing = CONNECTIONS.get(callId);
        if (existing != null) {
            existing.markActiveFromApp();
            return;
        }
        try {
            TelecomManager telecom = telecom(context);
            if (telecom == null) return;
            PhoneAccountHandle handle = ensurePhoneAccount(context);
            Bundle callExtras = callExtras(callId, displayName, callType, 0L);
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            extras.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callExtras);
            telecom.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, callId, null), extras);
            Log.i(TAG, "Reported outgoing call to Telecom callId=" + callId);
        } catch (RuntimeException error) {
            Log.w(TAG, "Telecom outgoing call report failed callId=" + callId, error);
        }
    }

    static AutoAiCallConnection createConnection(Context context, Bundle extras, boolean incoming) {
        Bundle callExtras = extras == null ? new Bundle() : extras;
        Bundle nested = incoming
            ? callExtras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS)
            : callExtras.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS);
        if (nested != null) callExtras = nested;
        AutoAiCallConnection connection = new AutoAiCallConnection(
            context.getApplicationContext(),
            callExtras.getString(EXTRA_CALL_ID, ""),
            callExtras.getString(EXTRA_CALLER_NAME, "Auto-AI call"),
            callExtras.getString(EXTRA_CALL_TYPE, "audio"),
            callExtras.getLong(EXTRA_EXPIRES_AT, 0L),
            incoming
        );
        if (!connection.callId().isEmpty()) CONNECTIONS.put(connection.callId(), connection);
        return connection;
    }

    static void unregister(String callId, AutoAiCallConnection connection) {
        if (callId != null) CONNECTIONS.remove(callId, connection);
    }

    public static void markActive(Context context, String callId) {
        AutoAiCallConnection connection = CONNECTIONS.get(callId);
        if (connection != null) connection.markActiveFromApp();
    }

    public static void disconnectLocal(Context context, String callId) {
        AutoAiCallConnection connection = CONNECTIONS.get(callId);
        if (connection != null) connection.disconnectLocal();
    }

    static void acceptFromTelecom(Context context, String callId, long expiresAt) {
        CallNotificationManager.savePending(context, callId, "accept", expiresAt > 0L ? expiresAt : System.currentTimeMillis() + 60000L);
        CallNotificationManager.cancelNotification(context, callId);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_ACTION, "accept");
        context.startActivity(intent);
    }

    static void rejectFromTelecom(Context context, String callId) {
        Intent intent = new Intent(context, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_REJECT);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        context.sendBroadcast(intent);
    }

    static void endFromTelecom(Context context, String callId) {
        Intent intent = new Intent(context, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_END);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        context.sendBroadcast(intent);
    }

    private static boolean isAvailable(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && context.checkSelfPermission(Manifest.permission.MANAGE_OWN_CALLS) == PackageManager.PERMISSION_GRANTED;
    }

    private static PhoneAccountHandle ensurePhoneAccount(Context context) {
        PhoneAccountHandle handle = phoneAccountHandle(context);
        TelecomManager telecom = telecom(context);
        if (telecom != null && telecom.getPhoneAccount(handle) == null) {
            PhoneAccount account = PhoneAccount.builder(handle, "Auto-AI")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription("Auto-AI calls")
                .setSupportedUriSchemes(java.util.Collections.singletonList(PhoneAccount.SCHEME_SIP))
                .build();
            telecom.registerPhoneAccount(account);
            Log.i(TAG, "Registered self-managed Telecom phone account.");
        }
        return handle;
    }

    private static PhoneAccountHandle phoneAccountHandle(Context context) {
        return new PhoneAccountHandle(new ComponentName(context, AutoAiConnectionService.class), ACCOUNT_ID);
    }

    private static TelecomManager telecom(Context context) {
        return (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE);
    }

    private static Bundle callExtras(String callId, String displayName, String callType, long expiresAt) {
        Bundle bundle = new Bundle();
        bundle.putString(EXTRA_CALL_ID, callId);
        bundle.putString(EXTRA_CALLER_NAME, displayName == null || displayName.trim().isEmpty() ? "Auto-AI call" : displayName.trim());
        bundle.putString(EXTRA_CALL_TYPE, "video".equals(callType) ? "video" : "audio");
        bundle.putLong(EXTRA_EXPIRES_AT, expiresAt);
        return bundle;
    }

    private static String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    private static long parseLong(String value) {
        try { return Long.parseLong(value == null ? "0" : value); }
        catch (NumberFormatException ignored) { return 0L; }
    }
}
