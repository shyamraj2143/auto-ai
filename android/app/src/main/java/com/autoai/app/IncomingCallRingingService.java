package com.autoai.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Log;

import androidx.annotation.Nullable;

public final class IncomingCallRingingService extends Service {
    private static final String TAG = "AutoAiRinging";
    private static final String ACTION_START = "com.autoai.app.ringing.START";
    private static final String ACTION_STOP = "com.autoai.app.ringing.STOP";
    private static final String EXTRA_NOTIFICATION = "incoming_notification";
    private static final String EXTRA_EXPIRES = "ring_expires_at";
    private static String activeCallId;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private Ringtone ringtone;
    private MediaPlayer mediaPlayer;
    private Vibrator vibrator;

    public static void start(Context context, String callId, long expiresAt, Notification notification) {
        Intent intent = new Intent(context, IncomingCallRingingService.class).setAction(ACTION_START)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId).putExtra(EXTRA_EXPIRES, expiresAt)
            .putExtra(EXTRA_NOTIFICATION, notification);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent); else context.startService(intent);
        } catch (RuntimeException error) {
            Log.e(TAG, "RINGING_SERVICE_START_FAILED call_id=" + callId, error);
        }
    }

    public static void stop(Context context, String callId) {
        try {
            context.startService(new Intent(context, IncomingCallRingingService.class).setAction(ACTION_STOP)
                .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId));
        } catch (RuntimeException error) {
            context.stopService(new Intent(context, IncomingCallRingingService.class));
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String callId = intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID);
        if (ACTION_STOP.equals(intent.getAction())) {
            if (activeCallId == null || activeCallId.equals(callId)) stopSelf();
            return START_NOT_STICKY;
        }
        long expiresAt = intent.getLongExtra(EXTRA_EXPIRES, 0L);
        Notification notification = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra(EXTRA_NOTIFICATION, Notification.class)
            : intent.getParcelableExtra(EXTRA_NOTIFICATION);
        if (!ACTION_START.equals(intent.getAction()) || callId == null || notification == null || expiresAt <= System.currentTimeMillis()) {
            stopSelf(); return START_NOT_STICKY;
        }
        if (callId.equals(activeCallId)) return START_NOT_STICKY;
        stopPlayback();
        activeCallId = callId;
        int id = CallNotificationManager.notificationId(callId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
        else startForeground(id, notification);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(CallNotificationManager.notificationTag(callId), 0);
        Log.i(TAG, "RINGING_SERVICE_STARTED call_id=" + callId);
        startPlayback();
        handler.postDelayed(this::stopSelf, Math.max(1000L, expiresAt - System.currentTimeMillis()));
        return START_NOT_STICKY;
    }

    private void startPlayback() {
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (audioManager == null || audioManager.getRingerMode() == AudioManager.RINGER_MODE_SILENT) return;
        AudioAttributes attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE).setAudioAttributes(attributes).build();
            if (audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) Log.i(TAG, "RINGTONE_AUDIO_FOCUS_GRANTED");
        } else if (audioManager.requestAudioFocus(null, AudioManager.STREAM_RING, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            Log.i(TAG, "RINGTONE_AUDIO_FOCUS_GRANTED");
        }
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ringtone = RingtoneManager.getRingtone(this, uri);
                ringtone.setAudioAttributes(attributes); ringtone.setLooping(true); ringtone.play();
            } else {
                mediaPlayer = new MediaPlayer(); mediaPlayer.setDataSource(this, uri); mediaPlayer.setAudioAttributes(attributes);
                mediaPlayer.setLooping(true); mediaPlayer.prepare(); mediaPlayer.start();
            }
            Log.i(TAG, "RINGTONE_LOOP_STARTED");
        } catch (Exception error) { Log.w(TAG, "Ringtone start failed", error); }
        vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        if (vibrator != null && vibrator.hasVibrator() && audioManager.getRingerMode() != AudioManager.RINGER_MODE_SILENT) {
            long[] pattern = {0, 700, 350, 700};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0)); else vibrator.vibrate(pattern, 0);
            Log.i(TAG, "VIBRATION_STARTED");
        }
    }

    private void stopPlayback() {
        handler.removeCallbacksAndMessages(null);
        if (ringtone != null) { ringtone.stop(); ringtone = null; Log.i(TAG, "RINGTONE_STOPPED"); }
        if (mediaPlayer != null) { try { mediaPlayer.stop(); } catch (RuntimeException ignored) {} mediaPlayer.release(); mediaPlayer = null; Log.i(TAG, "RINGTONE_STOPPED"); }
        if (vibrator != null) { vibrator.cancel(); vibrator = null; Log.i(TAG, "VIBRATION_STOPPED"); }
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest); else audioManager.abandonAudioFocus(null);
            Log.i(TAG, "AUDIO_FOCUS_RELEASED");
        }
        focusRequest = null; audioManager = null;
    }

    @Override public void onDestroy() {
        String stopped = activeCallId; stopPlayback(); activeCallId = null;
        Log.i(TAG, "RINGING_SERVICE_STOPPED call_id=" + stopped);
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
