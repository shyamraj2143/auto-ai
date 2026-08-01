package com.autoai.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import java.util.Locale;

public final class AlarmRingingService extends Service {
    private static final String CHANNEL_ID = "auto_ai_alarm_ringing_v1";
    private static final String ACTION_START = "com.autoai.app.alarm.START_RINGING";
    private static final String ACTION_STOP = "com.autoai.app.alarm.STOP_RINGING";
    private static final long MAX_RING_DURATION_MS = 10L * 60L * 1000L;
    private static final String UTTERANCE_ID = "auto_ai_alarm_voice";
    private static volatile String activeAlarmId;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlarmPayload currentAlarm;
    private MediaPlayer ringtonePlayer;
    private TextToSpeech textToSpeech;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private float ringtoneVolume = .82f;
    private boolean speaking;

    static void start(Context context, String alarmId) {
        Intent intent = new Intent(context, AlarmRingingService.class)
            .setAction(ACTION_START)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId);
        ContextCompat.startForegroundService(context, intent);
    }

    static void stop(Context context, String alarmId) {
        String active = activeAlarmId;
        if (alarmId != null && active != null && !alarmId.equals(active)) return;
        context.stopService(new Intent(context, AlarmRingingService.class));
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "AI alarms", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("AutoAI alarm ringtone and personal assistant reminders");
        channel.setSound(null, new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0L, 450L, 250L, 450L });
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        manager.createNotificationChannel(channel);
    }

    @Override public void onCreate() {
        super.onCreate();
        createChannel(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        String alarmId = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        if (ACTION_STOP.equals(action)) {
            if (currentAlarm == null || alarmId == null || currentAlarm.alarmId.equals(alarmId)) stopSelfSafely();
            return START_NOT_STICKY;
        }
        AlarmPayload payload = AlarmStore.get(this, alarmId);
        if (payload == null || !payload.enabled) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }
        if (currentAlarm != null && currentAlarm.alarmId.equals(payload.alarmId) && currentAlarm.revision == payload.revision) {
            return START_NOT_STICKY;
        }
        stopPlayback();
        currentAlarm = payload;
        activeAlarmId = payload.alarmId;
        ringtoneVolume = "gentle".equals(payload.ringtone) ? .46f : "energetic".equals(payload.ringtone) ? 1f : .82f;
        AlarmStore.markRinging(this, payload.alarmId);
        startForeground(AlarmPayload.requestCode(payload.alarmId), notification(payload));
        acquireWakeLock();
        requestAudioFocus();
        startRingtone(payload);
        startSpeech(payload);
        handler.postDelayed(() -> {
            if (currentAlarm != null) {
                String id = currentAlarm.alarmId;
                AlarmPayload completed = AlarmStore.markCompleted(this, id);
                if (completed != null) {
                    AlarmActionSyncWorker.enqueue(this, id, "dismiss", 0, 0L, completed.revision);
                }
                AlarmActionReceiver.broadcast(this, id, "timeout");
            }
            stopSelfSafely();
        }, MAX_RING_DURATION_MS);
        Log.i("AutoAiAlarm", "ALARM_RINGING_STARTED alarmId=" + payload.alarmId);
        return START_NOT_STICKY;
    }

    private Notification notification(AlarmPayload alarm) {
        Intent activityIntent = new Intent(this, AlarmRingingActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.alarmId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, AlarmPayload.requestCode(alarm.alarmId), activityIntent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(alarm.title)
            .setContentText(alarm.assistantMessage)
            .setStyle(new Notification.BigTextStyle().bigText(alarm.assistantMessage))
            .setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(open)
            .setFullScreenIntent(open, true)
            .setWhen(alarm.scheduledAtEpochMs)
            .setShowWhen(true)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_lock_idle_alarm, "Snooze 10 min", AlarmActionReceiver.pending(this, alarm, true)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", AlarmActionReceiver.pending(this, alarm, false)).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_MAX);
        return builder.build();
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autoai:ai-alarm");
        wakeLock.acquire(MAX_RING_DURATION_MS + 15_000L);
    }

    private void requestAudioFocus() {
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (audioManager == null) return;
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(change -> {})
                .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(change -> {}, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void startRingtone(AlarmPayload alarm) {
        try {
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM);
            if (uri == null) uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            ringtonePlayer = new MediaPlayer();
            ringtonePlayer.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
            ringtonePlayer.setDataSource(this, uri);
            ringtonePlayer.setLooping(true);
            ringtonePlayer.setVolume(ringtoneVolume, ringtoneVolume);
            ringtonePlayer.prepare();
            ringtonePlayer.start();
        } catch (Exception error) {
            Log.w("AutoAiAlarm", "Unable to play system alarm ringtone", error);
        }
    }

    private void startSpeech(AlarmPayload alarm) {
        textToSpeech = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || currentAlarm == null) return;
            configureVoice(textToSpeech, alarm.language, alarm.voiceStyle);
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { speaking = true; lowerRingtone(true); }
                @Override public void onDone(String utteranceId) {
                    speaking = false;
                    handler.post(() -> {
                        lowerRingtone(false);
                        if (currentAlarm != null) handler.postDelayed(AlarmRingingService.this::speakCurrent, 16_000L);
                    });
                }
                @Override public void onError(String utteranceId) { onDone(utteranceId); }
            });
            handler.postDelayed(this::speakCurrent, 1_600L);
        });
    }

    private void speakCurrent() {
        if (currentAlarm == null || textToSpeech == null || speaking) return;
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        textToSpeech.speak(currentAlarm.assistantMessage, TextToSpeech.QUEUE_FLUSH, params, UTTERANCE_ID);
    }

    static void configureVoice(TextToSpeech speech, String language, String style) {
        String tag = "hinglish-IN".equals(language) ? "hi-IN" : language;
        speech.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        int languageResult = speech.setLanguage(Locale.forLanguageTag(tag));
        if (languageResult == TextToSpeech.LANG_MISSING_DATA || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            speech.setLanguage(Locale.getDefault());
        }
        speech.setSpeechRate("gentle".equals(style) ? .84f : "energetic".equals(style) ? 1.04f : .93f);
        speech.setPitch("gentle".equals(style) ? .92f : "energetic".equals(style) ? 1.07f : 1f);
    }

    private void lowerRingtone(boolean lower) {
        if (ringtonePlayer == null) return;
        float volume = lower ? Math.min(.14f, ringtoneVolume) : ringtoneVolume;
        try { ringtonePlayer.setVolume(volume, volume); }
        catch (IllegalStateException ignored) {}
    }

    private void stopSelfSafely() {
        stopPlayback();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void stopPlayback() {
        handler.removeCallbacksAndMessages(null);
        if (ringtonePlayer != null) {
            try { ringtonePlayer.stop(); } catch (IllegalStateException ignored) {}
            ringtonePlayer.release();
            ringtonePlayer = null;
        }
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        if (audioManager != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) audioManager.abandonAudioFocusRequest(audioFocusRequest);
            else audioManager.abandonAudioFocus(null);
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        speaking = false;
        activeAlarmId = null;
        currentAlarm = null;
    }

    @Override public void onDestroy() {
        stopPlayback();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
