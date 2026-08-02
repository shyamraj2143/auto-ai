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
import android.media.ToneGenerator;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;

import java.util.Locale;
import java.util.Set;

public final class AlarmRingingService extends Service {
    private static final String CHANNEL_ID = "auto_ai_alarm_ringing_v1";
    private static final String ACTION_START = "com.autoai.app.alarm.START_RINGING";
    private static final String ACTION_STOP = "com.autoai.app.alarm.STOP_RINGING";
    private static final String ACTION_SPEAK_FEEDBACK = "com.autoai.app.alarm.SPEAK_AWAKE_FEEDBACK";
    private static final String ACTION_VERIFIED_SUCCESS = "com.autoai.app.alarm.SPEAK_VERIFIED_SUCCESS";
    private static final String EXTRA_SPEECH_MESSAGE = "alarm_speech_message";
    private static final String UTTERANCE_REMINDER = "auto_ai_alarm_reminder";
    private static final String UTTERANCE_FEEDBACK = "auto_ai_alarm_awake_feedback";
    private static final String UTTERANCE_SUCCESS = "auto_ai_alarm_verified_success";
    private static volatile String activeAlarmId;
    private static volatile AlarmRingingService activeInstance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private AlarmPayload currentAlarm;
    private MediaPlayer ringtonePlayer;
    private TextToSpeech textToSpeech;
    private ToneGenerator fallbackTone;
    private PowerManager.WakeLock wakeLock;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private float ringtoneVolume = .82f;
    private boolean speaking;
    private boolean completingVerifiedDismissal;
    private boolean verifiedDismissSent;
    private String pendingSpeech;
    private String pendingUtteranceId;
    private final Runnable reminderSpeech = this::speakCurrent;
    private final Runnable verifiedDismissFallback = this::finishVerifiedDismissal;
    private final Runnable fallbackTonePulse = new Runnable() {
        @Override public void run() {
            if (fallbackTone == null || currentAlarm == null) return;
            fallbackTone.startTone(ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 950);
            handler.postDelayed(this, 1_250L);
        }
    };

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

    static void speakAwakeFeedback(Context context, String alarmId, String message) {
        control(context, ACTION_SPEAK_FEEDBACK, alarmId, message);
    }

    static void speakVerifiedSuccess(Context context, String alarmId, String message) {
        control(context, ACTION_VERIFIED_SUCCESS, alarmId, message);
    }

    private static void control(Context context, String action, String alarmId, String message) {
        if (alarmId == null || !alarmId.equals(activeAlarmId)) return;
        AlarmRingingService service = activeInstance;
        if (service == null) return;
        service.handler.post(() -> {
            if (ACTION_VERIFIED_SUCCESS.equals(action)) service.beginVerifiedSuccess(message);
            else service.speakFeedback(message);
        });
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
        activeInstance = this;
        createChannel(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        String alarmId = intent == null ? null : intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        if (ACTION_STOP.equals(action)) {
            if (currentAlarm == null || alarmId == null || currentAlarm.alarmId.equals(alarmId)) stopSelfSafely();
            return START_NOT_STICKY;
        }
        if (ACTION_SPEAK_FEEDBACK.equals(action) || ACTION_VERIFIED_SUCCESS.equals(action)) {
            if (currentAlarm != null && alarmId != null && currentAlarm.alarmId.equals(alarmId)) {
                String message = intent.getStringExtra(EXTRA_SPEECH_MESSAGE);
                if (ACTION_VERIFIED_SUCCESS.equals(action)) beginVerifiedSuccess(message);
                else speakFeedback(message);
            }
            return START_STICKY;
        }
        AlarmPayload payload = alarmId == null ? AlarmStore.ringing(this) : AlarmStore.get(this, alarmId);
        if (payload == null || !payload.enabled) {
            stopSelfSafely();
            return START_NOT_STICKY;
        }
        if (currentAlarm != null && currentAlarm.alarmId.equals(payload.alarmId) && currentAlarm.revision == payload.revision) {
            return START_STICKY;
        }
        stopPlayback();
        currentAlarm = payload;
        activeAlarmId = payload.alarmId;
        ringtoneVolume = "gentle".equals(payload.ringtone) ? .46f : "energetic".equals(payload.ringtone) ? 1f : .82f;
        AlarmStore.markRinging(this, payload.alarmId);
        AlarmActionSyncWorker.enqueue(this, payload.alarmId, "ringing", 0, 0L, payload.revision);
        startForeground(AlarmPayload.requestCode(payload.alarmId), notification(payload));
        acquireWakeLock();
        requestAudioFocus();
        startRingtone(payload);
        startSpeech(payload);
        Log.i("AutoAiAlarm", "ALARM_RINGING_STARTED alarmId=" + payload.alarmId);
        return START_STICKY;
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
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_camera, "Stop with face check", AlarmAwakeVerificationActivity.pendingIntent(this, alarm)).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_MAX);
        return builder.build();
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autoai:ai-alarm");
        wakeLock.acquire();
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
            startFallbackTone();
        }
    }

    private void startFallbackTone() {
        try {
            fallbackTone = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            handler.post(fallbackTonePulse);
        } catch (RuntimeException error) {
            Log.w("AutoAiAlarm", "Unable to start fallback alarm tone", error);
        }
    }

    private void startSpeech(AlarmPayload alarm) {
        textToSpeech = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS || currentAlarm == null) return;
            configureVoice(textToSpeech, alarm.language, alarm.voiceStyle);
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { speaking = true; lowerRingtone(true); }
                @Override public void onDone(String utteranceId) { handler.post(() -> speechFinished(utteranceId)); }
                @Override public void onError(String utteranceId) { handler.post(() -> speechFinished(utteranceId)); }
            });
            if (pendingSpeech != null) speakPending();
            else handler.postDelayed(reminderSpeech, 1_600L);
        });
    }

    private void speakCurrent() {
        if (currentAlarm == null || textToSpeech == null || speaking || completingVerifiedDismissal) return;
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        int result = textToSpeech.speak(currentAlarm.assistantMessage, TextToSpeech.QUEUE_FLUSH, params, UTTERANCE_REMINDER);
        if (result == TextToSpeech.ERROR) handler.post(() -> speechFinished(UTTERANCE_REMINDER));
    }

    private void speakFeedback(String message) {
        if (message == null || message.trim().isEmpty() || completingVerifiedDismissal) return;
        handler.removeCallbacks(reminderSpeech);
        pendingSpeech = message.trim();
        pendingUtteranceId = UTTERANCE_FEEDBACK;
        speakPending();
    }

    private void beginVerifiedSuccess(String message) {
        if (completingVerifiedDismissal || verifiedDismissSent) return;
        completingVerifiedDismissal = true;
        handler.removeCallbacks(reminderSpeech);
        stopAlarmToneOnly();
        pendingSpeech = message == null ? "" : message.trim();
        pendingUtteranceId = UTTERANCE_SUCCESS;
        handler.removeCallbacks(verifiedDismissFallback);
        handler.postDelayed(verifiedDismissFallback, 14_000L);
        if (pendingSpeech.isEmpty()) {
            handler.postDelayed(verifiedDismissFallback, 650L);
            return;
        }
        speakPending();
    }

    private void speakPending() {
        if (pendingSpeech == null || pendingUtteranceId == null || textToSpeech == null || speaking) return;
        String message = pendingSpeech;
        String utteranceId = pendingUtteranceId;
        pendingSpeech = null;
        pendingUtteranceId = null;
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, 1f);
        int result = textToSpeech.speak(message, TextToSpeech.QUEUE_FLUSH, params, utteranceId);
        if (result == TextToSpeech.ERROR) handler.post(() -> speechFinished(utteranceId));
    }

    private void speechFinished(String utteranceId) {
        speaking = false;
        if (UTTERANCE_SUCCESS.equals(utteranceId)) {
            finishVerifiedDismissal();
            return;
        }
        lowerRingtone(false);
        if (pendingSpeech != null) {
            speakPending();
            return;
        }
        if (currentAlarm != null && !completingVerifiedDismissal) {
            handler.removeCallbacks(reminderSpeech);
            handler.postDelayed(reminderSpeech, UTTERANCE_FEEDBACK.equals(utteranceId) ? 10_000L : 16_000L);
        }
    }

    private void finishVerifiedDismissal() {
        if (!completingVerifiedDismissal || verifiedDismissSent || currentAlarm == null) return;
        verifiedDismissSent = true;
        handler.removeCallbacks(verifiedDismissFallback);
        sendBroadcast(new Intent(this, AlarmActionReceiver.class)
            .setAction(AlarmActionReceiver.ACTION_DISMISS)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, currentAlarm.alarmId)
            .putExtra(AlarmActionReceiver.EXTRA_AWAKE_VERIFIED, true));
    }

    private void stopAlarmToneOnly() {
        handler.removeCallbacks(fallbackTonePulse);
        if (ringtonePlayer != null) {
            try { ringtonePlayer.stop(); } catch (IllegalStateException ignored) {}
            ringtonePlayer.release();
            ringtonePlayer = null;
        }
        if (fallbackTone != null) {
            fallbackTone.release();
            fallbackTone = null;
        }
    }

    static void configureVoice(TextToSpeech speech, String language, String style) {
        String tag = "hinglish-IN".equals(language) ? "hi-IN" : language;
        Locale selectedLocale = Locale.forLanguageTag(tag);
        speech.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build());
        int languageResult = speech.setLanguage(selectedLocale);
        if (languageResult == TextToSpeech.LANG_MISSING_DATA || languageResult == TextToSpeech.LANG_NOT_SUPPORTED) {
            selectedLocale = Locale.getDefault();
            speech.setLanguage(selectedLocale);
        }
        Voice offlineVoice = bestOfflineVoice(speech, selectedLocale);
        if (offlineVoice != null) speech.setVoice(offlineVoice);
        speech.setSpeechRate("gentle".equals(style) ? .84f : "energetic".equals(style) ? 1.04f : .93f);
        speech.setPitch("gentle".equals(style) ? .92f : "energetic".equals(style) ? 1.07f : 1f);
    }

    private static Voice bestOfflineVoice(TextToSpeech speech, Locale requested) {
        final Set<Voice> voices;
        try { voices = speech.getVoices(); }
        catch (RuntimeException unavailable) { return null; }
        if (voices == null || voices.isEmpty()) return null;
        Voice best = null;
        int bestScore = Integer.MIN_VALUE;
        for (Voice voice : voices) {
            if (voice == null || voice.isNetworkConnectionRequired() || voice.getLocale() == null) continue;
            Locale locale = voice.getLocale();
            if (!locale.getLanguage().equalsIgnoreCase(requested.getLanguage())) continue;
            int score = voice.getQuality() - voice.getLatency();
            if (!requested.getCountry().isEmpty() && locale.getCountry().equalsIgnoreCase(requested.getCountry())) score += 10_000;
            if (score > bestScore) {
                best = voice;
                bestScore = score;
            }
        }
        return best;
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
        stopAlarmToneOnly();
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
        completingVerifiedDismissal = false;
        verifiedDismissSent = false;
        pendingSpeech = null;
        pendingUtteranceId = null;
        activeAlarmId = null;
        currentAlarm = null;
    }

    @Override public void onDestroy() {
        if (activeInstance == this) activeInstance = null;
        stopPlayback();
        super.onDestroy();
    }

    @Nullable @Override public IBinder onBind(Intent intent) { return null; }
}
