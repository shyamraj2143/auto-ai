package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class CallForegroundService extends Service implements NativeCallSessionController.Listener {
    private static final String TAG = "AutoAiCallService";
    private static final ExecutorService FAILURE_EXECUTOR = Executors.newSingleThreadExecutor();
    public static final String ACTION_START = "com.autoai.app.call.service.START";
    public static final String ACTION_STOP = "com.autoai.app.call.service.STOP";
    public static final String ACTION_SERVICE_STATUS = "com.autoai.app.call.service.STATUS";
    public static final String EXTRA_SERVICE_STATUS = "service_status";
    public static final String EXTRA_ERROR_CODE = "error_code";
    public static final String SERVICE_READY = "SERVICE_READY";
    public static final String SERVICE_FAILED = "SERVICE_FAILED";
    private AudioManager audioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerState;
    private String activeCallId;
    private AudioFocusRequest audioFocusRequest;
    private boolean explicitTerminalStop;
    private final ExecutorService recoveryExecutor = Executors.newSingleThreadExecutor();
    private NativeCallSessionController sessionController;
    private String activeDisplayName;
    private String activeCallType;
    private int activeNotificationId;
    private TelecomMode telecomMode = TelecomMode.UNAVAILABLE;

    @Override
    public void onCreate() {
        super.onCreate();
        CallNotificationManager.createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            explicitTerminalStop = true;
            activeCallId = clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
            stopSelf();
            return START_NOT_STICKY;
        }
        boolean recovery = intent == null || !ACTION_START.equals(intent.getAction());
        activeCallId = recovery ? firstNonEmpty(AcceptedCallHandoffStore.callId(this), AutoAiCallsPlugin.activeCallId(this)) : clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        String displayName = recovery ? AcceptedCallHandoffStore.peerName(this) : clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALLER_NAME));
        String callType = recovery ? firstNonEmpty(AcceptedCallHandoffStore.callType(this), AutoAiCallsPlugin.activeCallType(this)) : clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE));
        if (activeCallId == null || (!"audio".equals(callType) && !"video".equals(callType))) {
            failStart(activeCallId, "INTERNAL_SERVICE_ERROR");
            return START_NOT_STICKY;
        }
        if (!CallFailureMessages.isOnline(this)) {
            failStart(activeCallId, "NETWORK_LOST");
            return START_NOT_STICKY;
        }
        String missingPermission = missingCallPermission(callType);
        if (missingPermission != null) {
            failStart(activeCallId, missingPermission);
            return START_NOT_STICKY;
        }
        if (!hasDeclaredServiceTypes(callType)) {
            failStart(activeCallId, "FOREGROUND_SERVICE_TYPE_MISSING");
            return START_NOT_STICKY;
        }
        AcceptedCallHandoffStore.setState(this, activeCallId, AcceptedCallHandoffStore.State.SERVICE_STARTING);
        Log.i(TAG, "SERVICE_STARTING callId=" + activeCallId);
        activeDisplayName = displayName;
        activeCallType = callType;
        Notification notification;
        try {
            notification = buildNotification(displayName, callType);
        } catch (RuntimeException error) {
            Log.e(TAG, "Unable to build foreground notification callId=" + activeCallId, error);
            failStart(activeCallId, "FOREGROUND_NOTIFICATION_FAILED");
            return START_NOT_STICKY;
        }
        int notificationId = CallNotificationManager.notificationId(activeCallId) + 100000;
        activeNotificationId = notificationId;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {                int serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    if ("video".equals(callType)) serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                startForeground(notificationId, notification, serviceType);
            } else {
                startForeground(notificationId, notification);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "Foreground call service startForeground failed callId=" + activeCallId, error);
            String simpleName = error.getClass().getSimpleName();
            String code = "MissingForegroundServiceTypeException".equals(simpleName)
                ? "FOREGROUND_SERVICE_TYPE_MISSING"                : error instanceof SecurityException ? "FOREGROUND_SERVICE_START_NOT_ALLOWED"
                    : Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                    ? "FOREGROUND_SERVICE_START_NOT_ALLOWED" : "FOREGROUND_NOTIFICATION_FAILED";
            failStart(activeCallId, code);
            return START_NOT_STICKY;
        }
        if (!initializeAudio(callType)) {
            Log.w(TAG, "AUDIO_FOCUS_DEGRADED callId=" + activeCallId + "; continuing call setup");
        }
        TelecomRegistrationResult telecomResult = AutoAiTelecomBridge.ensureRegisteredDetailed(this);
        if (telecomResult.isRegistered()) {
            telecomMode = TelecomMode.ENABLED;
            AutoAiTelecomBridge.markActive(this, activeCallId);
        } else {
            telecomMode = telecomResult == TelecomRegistrationResult.UNSUPPORTED
                || telecomResult == TelecomRegistrationResult.TELECOM_UNAVAILABLE
                ? TelecomMode.UNAVAILABLE : TelecomMode.DEGRADED;
            Log.w(TAG, "Telecom integration degraded callId=" + activeCallId + " result=" + telecomResult
                + " telecomMode=" + telecomMode + "; continuing native WebRTC");
        }
        try {
            AutoAiCallsPlugin.saveActiveCall(this, activeCallId, callType);
            sessionController = NativeCallSessionController.get(this);
            sessionController.addListener(this);
            sessionController.start(activeCallId, callType, displayName);
        } catch (RuntimeException error) {
            Log.e(TAG, "Unable to register active call metadata callId=" + activeCallId, error);
            failStart(activeCallId, "INTERNAL_SERVICE_ERROR");
            return START_NOT_STICKY;
        }
        AcceptedCallHandoffStore.setState(this, activeCallId, AcceptedCallHandoffStore.State.SERVICE_READY);
        CallNotificationManager.showOngoingCall(this, activeCallId);
        broadcastStatus(activeCallId, SERVICE_READY, null);
        Log.i(TAG, "SERVICE_READY callId=" + activeCallId + " recovery=" + recovery + " telecomMode=" + telecomMode);
        if (recovery) reconcileRecoveredCall(activeCallId);
        Log.i(TAG, "Foreground call service running callId=" + activeCallId + " type=" + callType);
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        if (sessionController != null) sessionController.removeListener(this);
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } else {
                audioManager.abandonAudioFocus(null);
            }
            audioManager.setSpeakerphoneOn(previousSpeakerState);
            audioManager.setMode(previousAudioMode);
        }
        if (activeCallId != null && explicitTerminalStop) {
            Log.i(TAG, "Foreground call service destroyed callId=" + activeCallId);
            if (sessionController != null) sessionController.terminateAfterBackendAction(activeCallId);
            AutoAiTelecomBridge.disconnectLocal(this, activeCallId);
            AutoAiCallsPlugin.clearActiveCall(this, activeCallId);
            CallNotificationManager.cancelOngoingCall(this, activeCallId);
            AcceptedCallHandoffStore.clearTerminal(this, activeCallId);
        } else if (activeCallId != null) {
            Log.i(TAG, "Preserving non-terminal call across service destruction callId=" + activeCallId);
        }
        recoveryExecutor.shutdownNow();
        super.onDestroy();
    }

    private Notification buildNotification(String displayName, String callType) {
        Intent openIntent = new Intent(this, ActiveCallActivity.class).setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, activeCallId)
            .putExtra(CallNotificationManager.EXTRA_ACTION, "resume_call")
            .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, callType);
        PendingIntent open = PendingIntent.getActivity(this, uniqueRequestCode(activeCallId, "resume_call"), openIntent, pendingFlags());
        Intent endIntent = new Intent(this, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_END).putExtra(CallNotificationManager.EXTRA_CALL_ID, activeCallId);
        PendingIntent end = PendingIntent.getBroadcast(this, uniqueRequestCode(activeCallId, "end"), endIntent, pendingFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CallNotificationManager.CHANNEL_ACTIVE)
            : new Notification.Builder(this);
        return builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(displayName == null ? "Auto-AI call" : displayName)
            .setContentText(telecomMode == TelecomMode.ENABLED ? "Connecting call…" : "Connecting through AutoAI secure calling…")
            .setContentIntent(open)
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(false)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", end).build())
            .build();
    }

    private String missingCallPermission(String callType) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return "MICROPHONE_PERMISSION_DENIED";
        }
        if ("video".equals(callType)
            && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            return "CAMERA_PERMISSION_DENIED";
        }
        return null;
    }

    private boolean initializeAudio(String callType) {
        try {
            audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager == null) return false;
            previousAudioMode = audioManager.getMode();
            previousSpeakerState = audioManager.isSpeakerphoneOn();
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
            audioManager.setSpeakerphoneOn("video".equals(callType));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(attributes)
                    .setAcceptsDelayedFocusGain(false)
                    .setOnAudioFocusChangeListener(focusChange -> Log.d(TAG, "Audio focus changed=" + focusChange))
                    .build();
                return audioManager.requestAudioFocus(audioFocusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            }
            return audioManager.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (RuntimeException error) {
            Log.w(TAG, "Audio focus setup degraded callId=" + activeCallId, error);
            return false;
        }
    }

    private void failStart(String callId, String errorCode) {
        CallNotificationManager.cancelOngoingCall(this, callId);
        broadcastStatus(callId, SERVICE_FAILED, errorCode);
        Log.e(TAG, "SERVICE_FAILED callId=" + callId + " errorCode=" + errorCode);
        if (callId != null) FAILURE_EXECUTOR.execute(() -> {
            try { new NativeCallApi(this).fail(callId, errorCode); }
            catch (Exception reportError) { Log.e(TAG, "Unable to synchronize service failure callId=" + callId, reportError); }
        });
        activeCallId = null;
        stopSelf();
    }

    private boolean hasDeclaredServiceTypes(String callType) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return true;
        try {
            ServiceInfo info = getPackageManager().getServiceInfo(new ComponentName(this, CallForegroundService.class), 0);            int required = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if ("video".equals(callType)) required |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            return (info.getForegroundServiceType() & required) == required;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    @Override public void onState(ActiveCallStore.State state, String errorCode) {
        if (activeCallId == null) return;
        if (state == ActiveCallStore.State.MEDIA_CONNECTED) {
            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CallNotificationManager.CHANNEL_ACTIVE)
                : new Notification.Builder(this);
            Intent openIntent = new Intent(this, ActiveCallActivity.class).setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(CallNotificationManager.EXTRA_CALL_ID, activeCallId)
                .putExtra(CallNotificationManager.EXTRA_ACTION, "resume_call")
                .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, activeCallType);
            PendingIntent open = PendingIntent.getActivity(this, uniqueRequestCode(activeCallId, "resume_call"), openIntent, pendingFlags());
            Intent endIntent = new Intent(this, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_END)
                .putExtra(CallNotificationManager.EXTRA_CALL_ID, activeCallId);
            PendingIntent end = PendingIntent.getBroadcast(this, uniqueRequestCode(activeCallId, "end"), endIntent, pendingFlags());
            Notification connected = builder.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(activeDisplayName == null ? "Auto-AI call" : activeDisplayName)
                .setContentText("Connected " + activeCallType + " call")
                .setContentIntent(open).setCategory(Notification.CATEGORY_CALL).setOngoing(true)
                .setUsesChronometer(true).setWhen(System.currentTimeMillis())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", end).build()).build();
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(activeNotificationId, connected);
        } else if (state == ActiveCallStore.State.TERMINAL) {
            if (errorCode != null) broadcastStatus(activeCallId, SERVICE_FAILED, errorCode);
            explicitTerminalStop = true;
            stopSelf();
        }
    }

    private void broadcastStatus(String callId, String status, String errorCode) {
        Intent result = new Intent(ACTION_SERVICE_STATUS).setPackage(getPackageName())
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId)
            .putExtra(EXTRA_SERVICE_STATUS, status);
        if (errorCode != null) result.putExtra(EXTRA_ERROR_CODE, errorCode);
        sendBroadcast(result);
    }

    private void reconcileRecoveredCall(String callId) {
        recoveryExecutor.execute(() -> {
            String accessToken = AutoAiSecureStoragePlugin.readStoredValue(this, "auto-ai-access-token");
            if (accessToken == null || accessToken.trim().isEmpty()) return;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "") + "/calls/" + callId).openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
                int responseCode = connection.getResponseCode();
                if (responseCode < 200 || responseCode >= 300) {
                    Log.w(TAG, "Recovered call reconciliation deferred callId=" + callId + " status=" + responseCode);
                    return;
                }
                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
                String status = new JSONObject(body.toString()).optString("status", "");
                if ("accepted".equals(status) || "connecting".equals(status) || "active".equals(status)) {
                    Log.i(TAG, "Recovered active call reconciled callId=" + callId + " backendStatus=" + status);
                    return;
                }
                if ("rejected".equals(status) || "cancelled".equals(status) || "missed".equals(status)
                    || "failed".equals(status) || "ended".equals(status)) {
                    explicitTerminalStop = true;
                    CallNotificationManager.cancelAllForTerminalCall(this, callId);
                    stopSelf();
                }
            } catch (Exception error) {
                Log.w(TAG, "Recovered call reconciliation deferred callId=" + callId, error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    static int uniqueRequestCode(String callId, String action) {
        return CallHandoffPolicy.requestCode(callId, action);
    }

    private String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    private String firstNonEmpty(String first, String second) {
        return clean(first) != null ? clean(first) : clean(second);
    }

    private int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }
}
