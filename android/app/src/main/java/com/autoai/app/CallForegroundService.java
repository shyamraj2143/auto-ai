package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;

public class CallForegroundService extends Service {
    private static final String TAG = "AutoAiCallService";
    public static final String ACTION_START = "com.autoai.app.call.service.START";
    public static final String ACTION_STOP = "com.autoai.app.call.service.STOP";
    private AudioManager audioManager;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private boolean previousSpeakerState;
    private String activeCallId;

    @Override
    public void onCreate() {
        super.onCreate();
        CallNotificationManager.createChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || !ACTION_START.equals(intent.getAction())) {
            Log.i(TAG, "Stopping foreground call service: missing start action.");
            stopSelf();
            return START_NOT_STICKY;
        }
        activeCallId = clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        String displayName = clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALLER_NAME));
        String callType = clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE));
        if (activeCallId == null || (!"audio".equals(callType) && !"video".equals(callType)) || !hasCallPermissions(callType)) {
            Log.w(TAG, "Foreground call service rejected start callId=" + activeCallId + " type=" + callType);
            activeCallId = null;
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification notification = buildNotification(displayName, callType);
        int notificationId = CallNotificationManager.notificationId(activeCallId) + 100000;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int serviceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                if ("video".equals(callType)) serviceType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                startForeground(notificationId, notification, serviceType);
            } else {
                startForeground(notificationId, notification);
            }
        } catch (RuntimeException error) {
            Log.e(TAG, "Foreground call service startForeground failed callId=" + activeCallId, error);
            activeCallId = null;
            stopSelf();
            return START_NOT_STICKY;
        }
        initializeAudio();
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
        if (audioManager != null) {
            audioManager.abandonAudioFocus(null);
            audioManager.setSpeakerphoneOn(previousSpeakerState);
            audioManager.setMode(previousAudioMode);
        }
        if (activeCallId != null) {
            Log.i(TAG, "Foreground call service destroyed callId=" + activeCallId);
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(CallNotificationManager.notificationId(activeCallId) + 100000);
        }
        super.onDestroy();
    }

    private Notification buildNotification(String displayName, String callType) {
        Intent openIntent = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 0, openIntent, pendingFlags());
        Intent endIntent = new Intent(this, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_END).putExtra(CallNotificationManager.EXTRA_CALL_ID, activeCallId);
        PendingIntent end = PendingIntent.getBroadcast(this, 1, endIntent, pendingFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CallNotificationManager.CHANNEL_ACTIVE)
            : new Notification.Builder(this);
        return builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(displayName == null ? "Auto-AI call" : displayName)
            .setContentText("Active " + ("audio".equals(callType) ? "audio" : "video") + " call")
            .setContentIntent(open)
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Hang up", end).build())
            .build();
    }

    private boolean hasCallPermissions(String callType) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return false;
        return !"video".equals(callType)
            || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void initializeAudio() {
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;
        previousAudioMode = audioManager.getMode();
        previousSpeakerState = audioManager.isSpeakerphoneOn();
        audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);
        audioManager.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
    }

    private String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }

    private int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }
}
