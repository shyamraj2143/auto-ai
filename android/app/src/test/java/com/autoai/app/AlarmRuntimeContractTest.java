package com.autoai.app;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class AlarmRuntimeContractTest {
    @Test public void exactAlarmPersistsAndRestoresAfterBoot() throws Exception {
        String scheduler = source("AlarmScheduler.java");
        String store = source("AlarmStore.java");
        String receiver = source("AlarmReceiver.java");
        assertTrue(scheduler.contains("setAlarmClock"));
        assertTrue(scheduler.contains("canScheduleExactAlarms"));
        assertTrue(scheduler.contains("exact_alarm_access_required"));
        assertFalse(scheduler.contains("setAndAllowWhileIdle"));
        assertTrue(scheduler.contains("\"ringing\".equals(payload.status)"));
        assertTrue(store.contains("SharedPreferences"));
        assertTrue(store.contains("replaceAll"));
        assertTrue(receiver.contains("ACTION_BOOT_COMPLETED"));
        assertTrue(receiver.contains("AlarmScheduler.rescheduleAll"));
    }

    @Test public void ringingUsesSystemAlarmAudioAndHumanVoice() throws Exception {
        String service = source("AlarmRingingService.java");
        assertTrue(service.contains("RingtoneManager.TYPE_ALARM"));
        assertTrue(service.contains("ToneGenerator.STREAM_ALARM") || service.contains("new ToneGenerator(AudioManager.STREAM_ALARM"));
        assertTrue(service.contains("TextToSpeech"));
        assertTrue(service.contains("AudioAttributes.USAGE_ALARM"));
        assertTrue(service.contains("AudioAttributes.CONTENT_TYPE_SPEECH"));
        assertTrue(service.contains("setFullScreenIntent(open, true)"));
        assertTrue(service.contains("configureVoice"));
        assertTrue(service.contains("isNetworkConnectionRequired"));
        assertTrue(service.contains("ACTION_SPEAK_FEEDBACK"));
        assertTrue(service.contains("ACTION_VERIFIED_SUCCESS"));
    }

    @Test public void lockScreenAlarmRequiresLiveAwakeVerificationToStop() throws Exception {
        String activity = source("AlarmRingingActivity.java");
        String verifierActivity = source("AlarmAwakeVerificationActivity.java");
        String verifier = source("AlarmAwakeVerifier.java");
        String actions = source("AlarmActionReceiver.java");
        String service = source("AlarmRingingService.java");
        assertTrue(activity.contains("setShowWhenLocked(true)"));
        assertTrue(activity.contains("setTurnScreenOn(true)"));
        assertTrue(activity.contains("Snooze 10 min"));
        assertTrue(activity.contains("Stop alarm"));
        assertTrue(activity.contains("HH:mm:ss"));
        assertTrue(activity.contains("24-HOUR FORMAT"));
        assertTrue(activity.contains("AlarmAwakeVerificationActivity"));
        assertTrue(verifierActivity.contains("ImageCapture"));
        assertTrue(verifierActivity.contains("AlarmRingingService.speakAwakeFeedback"));
        assertTrue(verifierActivity.contains("AlarmRingingService.speakVerifiedSuccess"));
        assertTrue(verifier.contains("FaceDetection.getClient"));
        assertTrue(verifier.contains("getLeftEyeOpenProbability"));
        assertTrue(verifier.contains("verify-awake"));
        assertTrue(actions.contains("!intent.getBooleanExtra(EXTRA_AWAKE_VERIFIED, false)"));
        assertFalse(service.contains("MAX_RING_DURATION_MS"));
        assertTrue(service.contains("START_STICKY"));
        assertFalse(activity.contains("WebView"));
    }

    @Test public void verificationSpeechExplainsFailureAndHandsOffToAiChat() throws Exception {
        String speech = source("AlarmAssistantSpeech.java");
        assertTrue(speech.contains("सोए हुए हैं"));
        assertTrue(speech.contains("अलार्म बंद नहीं होगा"));
        assertTrue(speech.contains("थैंक यू, अब आप जाग चुके हैं"));
        assertTrue(speech.contains("AI Chat"));
    }

    @Test public void offlineActionsRemainOrderedAndRefreshAuthentication() throws Exception {
        String worker = source("AlarmActionSyncWorker.java");
        String store = source("AlarmStore.java");
        assertTrue(worker.contains("ExistingWorkPolicy.APPEND_OR_REPLACE"));
        assertTrue(worker.contains("client_revision"));
        assertTrue(worker.contains("scheduled_at"));
        assertTrue(worker.contains("if (scheduledAt > 0L)"));
        assertTrue(source("AlarmActionReceiver.java").contains("scheduledAtEpochMs, completed.revision"));
        assertTrue(worker.contains("/auth/refresh"));
        assertTrue(store.contains("local.revision > remote.revision"));
        assertTrue(store.contains("preserveActiveRing"));
        assertTrue(source("AlarmRingingService.java").contains("\"ringing\", 0, 0L, payload.revision"));
    }

    @Test public void manifestDeclaresOnlyAlarmRequiredNativeAccess() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        assertTrue(manifest.contains("android.permission.SCHEDULE_EXACT_ALARM"));
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"));
        assertTrue(manifest.contains("android:name=\".AlarmRingingService\""));
        assertTrue(manifest.contains("android:name=\".AlarmRingingActivity\""));
        assertTrue(manifest.contains("android:name=\".AlarmAwakeVerificationActivity\""));
        assertTrue(manifest.contains("android:name=\".AlarmReceiver\""));
        String gradle = read("build.gradle");
        assertTrue(gradle.contains("com.google.mlkit:face-detection:16.1.7"));
    }

    private static String source(String file) throws Exception {
        return read("src/main/java/com/autoai/app/" + file);
    }

    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
    }
}
