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

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public final class AutoAiTelecomBridge {
    static final String EXTRA_CALL_ID = "auto_ai_call_id";
    static final String EXTRA_CALLER_NAME = "auto_ai_caller_name";
    static final String EXTRA_CALL_TYPE = "auto_ai_call_type";
    static final String EXTRA_EXPIRES_AT = "auto_ai_expires_at";

    private static final String TAG = "AutoAiTelecom";
    private static final String ACCOUNT_ID = "auto_ai_self_managed_v1";
    private static final Map<String, AutoAiCallConnection> CONNECTIONS = new ConcurrentHashMap<>();

    private AutoAiTelecomBridge() {}

    public static TelecomRegistrationResult ensureRegisteredDetailed(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return TelecomRegistrationResult.UNSUPPORTED;
        if (context.checkSelfPermission(Manifest.permission.MANAGE_OWN_CALLS) != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "Telecom registration unavailable: MANAGE_OWN_CALLS is missing.");
            return TelecomRegistrationResult.PERMISSION_MISSING;
        }
        TelecomManager manager = telecom(context);
        if (manager == null) return TelecomRegistrationResult.TELECOM_UNAVAILABLE;
        PhoneAccountHandle handle = phoneAccountHandle(context);
        try {
            boolean alreadyRegistered = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && containsExactHandle(manager.getOwnSelfManagedPhoneAccounts(), handle);
            PhoneAccount account = PhoneAccount.builder(handle, "Auto-AI")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setShortDescription("Auto-AI secure calls")
                .setSupportedUriSchemes(Collections.singletonList(PhoneAccount.SCHEME_SIP))
                .build();
            manager.registerPhoneAccount(account);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !containsExactHandle(manager.getOwnSelfManagedPhoneAccounts(), handle)) {
                Log.w(TAG, "Telecom OEM rejected self-managed account registration without an exception.");
                return TelecomRegistrationResult.OEM_REJECTED;
            }
            return alreadyRegistered ? TelecomRegistrationResult.ALREADY_REGISTERED : TelecomRegistrationResult.REGISTERED;
        } catch (SecurityException error) {
            logRegistrationException(error);
            return TelecomRegistrationResult.OEM_REJECTED;
        } catch (IllegalArgumentException | UnsupportedOperationException error) {
            logRegistrationException(error);
            return TelecomRegistrationResult.OEM_REJECTED;
        } catch (RuntimeException error) {
            logRegistrationException(error);
            return TelecomRegistrationResult.REGISTRATION_EXCEPTION;
        }
    }

    static boolean isRegistrationReady(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        if (context.checkSelfPermission(Manifest.permission.MANAGE_OWN_CALLS) != PackageManager.PERMISSION_GRANTED) return false;
        TelecomManager manager = telecom(context);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Registration completion is authoritative on API 26-32; do not request
            // cellular identity permissions only to perform a readback.
            return true;
        }
        try {
            return containsExactHandle(manager.getOwnSelfManagedPhoneAccounts(), phoneAccountHandle(context));
        } catch (RuntimeException error) {
            Log.w(TAG, "Telecom registration readiness check failed exception=" + error.getClass().getName()
                + " message=" + safeMessage(error));
            return false;
        }
    }

    public static TelecomCallResult reportIncomingCall(Context context, Map<String, String> data) {
        if (data == null) return TelecomCallResult.INVALID_METADATA;
        String callId = clean(data.get("call_id"));
        String callType = clean(data.get("call_type"));
        if (callId == null || (!("audio".equals(callType)) && !("video".equals(callType)))) return TelecomCallResult.INVALID_METADATA;
        TelecomRegistrationResult registration = ensureRegisteredDetailed(context);
        if (!registration.isRegistered()) return TelecomCallResult.REGISTRATION_UNAVAILABLE;
        try {
            TelecomManager manager = telecom(context);
            if (manager == null) return TelecomCallResult.REGISTRATION_UNAVAILABLE;
            Bundle callExtras = callExtras(callId, clean(data.get("caller_name")), callType, parseLong(data.get("expires_at_epoch_ms")));
            Bundle extras = new Bundle(callExtras);
            extras.putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callExtras);
            manager.addNewIncomingCall(phoneAccountHandle(context), extras);
            Log.i(TAG, "Reported incoming call to Telecom callId=" + callId);
            return TelecomCallResult.REPORTED;
        } catch (SecurityException error) { return reportFailure("incoming", callId, TelecomCallResult.SECURITY_EXCEPTION, error); }
        catch (IllegalArgumentException error) { return reportFailure("incoming", callId, TelecomCallResult.ILLEGAL_ARGUMENT, error); }
        catch (UnsupportedOperationException error) { return reportFailure("incoming", callId, TelecomCallResult.UNSUPPORTED_OPERATION, error); }
        catch (RuntimeException error) { return reportFailure("incoming", callId, TelecomCallResult.TELECOM_EXCEPTION, error); }
    }

    public static TelecomCallResult reportOutgoingCall(Context context, String callId, String displayName, String callType) {
        callId = clean(callId);
        if (callId == null || (!("audio".equals(callType)) && !("video".equals(callType)))) return TelecomCallResult.INVALID_METADATA;
        AutoAiCallConnection existing = CONNECTIONS.get(callId);
        if (existing != null) { existing.markActiveFromApp(); return TelecomCallResult.ALREADY_ACTIVE; }
        TelecomRegistrationResult registration = ensureRegisteredDetailed(context);
        if (!registration.isRegistered()) return TelecomCallResult.REGISTRATION_UNAVAILABLE;
        try {
            TelecomManager manager = telecom(context);
            if (manager == null) return TelecomCallResult.REGISTRATION_UNAVAILABLE;
            PhoneAccountHandle handle = phoneAccountHandle(context);
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            extras.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callExtras(callId, displayName, callType, 0L));
            manager.placeCall(Uri.fromParts(PhoneAccount.SCHEME_SIP, callId, null), extras);
            Log.i(TAG, "Reported outgoing call to Telecom callId=" + callId);
            return TelecomCallResult.REPORTED;
        } catch (SecurityException error) { return reportFailure("outgoing", callId, TelecomCallResult.SECURITY_EXCEPTION, error); }
        catch (IllegalArgumentException error) { return reportFailure("outgoing", callId, TelecomCallResult.ILLEGAL_ARGUMENT, error); }
        catch (UnsupportedOperationException error) { return reportFailure("outgoing", callId, TelecomCallResult.UNSUPPORTED_OPERATION, error); }
        catch (RuntimeException error) { return reportFailure("outgoing", callId, TelecomCallResult.TELECOM_EXCEPTION, error); }
    }

    static AutoAiCallConnection createConnection(Context context, Bundle extras, boolean incoming) {
        Bundle callExtras = extras == null ? new Bundle() : extras;
        Bundle nested = incoming ? callExtras.getBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS) : callExtras.getBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS);
        if (nested != null) callExtras = nested;
        String callId = clean(callExtras.getString(EXTRA_CALL_ID, ""));
        if (callId == null) return null;
        AutoAiCallConnection existing = CONNECTIONS.get(callId);
        if (existing != null) return existing;
        AutoAiCallConnection connection = new AutoAiCallConnection(context.getApplicationContext(), callId,
            callExtras.getString(EXTRA_CALLER_NAME, "Auto-AI call"), callExtras.getString(EXTRA_CALL_TYPE, "audio"),
            callExtras.getLong(EXTRA_EXPIRES_AT, 0L), incoming);
        CONNECTIONS.put(callId, connection);
        return connection;
    }

    static void unregister(String callId, AutoAiCallConnection connection) { if (callId != null) CONNECTIONS.remove(callId, connection); }
    public static void markActive(Context context, String callId) { AutoAiCallConnection connection = CONNECTIONS.get(callId); if (connection != null) connection.markActiveFromApp(); }
    public static void disconnectLocal(Context context, String callId) { AutoAiCallConnection connection = CONNECTIONS.get(callId); if (connection != null) connection.disconnectLocal(); }

    static void acceptFromTelecom(Context context, String callId, long expiresAt) {
        ActiveCallStore.Snapshot call = ActiveCallStore.get(context, callId);
        if (call == null) return;
        CallNotificationManager.savePending(context, callId, "accept", expiresAt > 0L ? expiresAt : System.currentTimeMillis() + 60000L);
        context.startActivity(CallIntentDispatcher.incomingIntent(context, call).putExtra(CallNotificationManager.EXTRA_ACTION, "accept"));
    }

    static void rejectFromTelecom(Context context, String callId) {
        Intent intent = new Intent(context, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_REJECT)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        ActiveCallStore.Snapshot call = ActiveCallStore.get(context, callId);
        if (call != null) intent.putExtra(CallNotificationManager.EXTRA_ACTION_TOKEN, call.actionToken);
        context.sendBroadcast(intent);
    }

    static void endFromTelecom(Context context, String callId) {
        context.sendBroadcast(new Intent(context, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_END)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId));
    }

    private static boolean containsExactHandle(List<PhoneAccountHandle> handles, PhoneAccountHandle expected) {
        return handles != null && handles.contains(expected);
    }

    private static PhoneAccountHandle phoneAccountHandle(Context context) {
        return new PhoneAccountHandle(new ComponentName(context, AutoAiConnectionService.class), ACCOUNT_ID);
    }

    private static TelecomManager telecom(Context context) { return (TelecomManager) context.getSystemService(Context.TELECOM_SERVICE); }

    private static Bundle callExtras(String callId, String displayName, String callType, long expiresAt) {
        Bundle bundle = new Bundle();
        bundle.putString(EXTRA_CALL_ID, callId);
        bundle.putString(EXTRA_CALLER_NAME, clean(displayName) == null ? "Auto-AI call" : displayName.trim());
        bundle.putString(EXTRA_CALL_TYPE, "video".equals(callType) ? "video" : "audio");
        bundle.putLong(EXTRA_EXPIRES_AT, expiresAt);
        return bundle;
    }

    private static TelecomCallResult reportFailure(String direction, String callId, TelecomCallResult result, RuntimeException error) {
        Log.w(TAG, "Telecom " + direction + " report degraded callId=" + callId + " exception=" + error.getClass().getName()
            + " message=" + safeMessage(error));
        return result;
    }

    private static void logRegistrationException(RuntimeException error) {
        Log.e(TAG, "Telecom registration exception=" + error.getClass().getName() + " message=" + safeMessage(error));
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) return "<none>";
        String safe = message.replaceAll("[\\r\\n]+", " ");
        return safe.substring(0, Math.min(240, safe.length()));
    }

    private static String clean(String value) { return value == null || value.trim().isEmpty() ? null : value.trim(); }
    private static long parseLong(String value) { try { return Long.parseLong(value == null ? "0" : value); } catch (NumberFormatException ignored) { return 0L; } }
}
