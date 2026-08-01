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
        assertTrue(scheduler.contains("setExactAndAllowWhileIdle"));
        assertTrue(scheduler.contains("canScheduleExactAlarms"));
        assertTrue(scheduler.contains("\"ringing\".equals(payload.status)"));
        assertTrue(store.contains("SharedPreferences"));
        assertTrue(store.contains("replaceAll"));
        assertTrue(receiver.contains("ACTION_BOOT_COMPLETED"));
        assertTrue(receiver.contains("AlarmScheduler.rescheduleAll"));
    }

    @Test public void ringingUsesSystemAlarmAudioAndHumanVoice() throws Exception {
        String service = source("AlarmRingingService.java");
        assertTrue(service.contains("RingtoneManager.TYPE_ALARM"));
        assertTrue(service.contains("TextToSpeech"));
        assertTrue(service.contains("AudioAttributes.USAGE_ALARM"));
        assertTrue(service.contains("AudioAttributes.CONTENT_TYPE_SPEECH"));
        assertTrue(service.contains("setFullScreenIntent(open, true)"));
        assertTrue(service.contains("configureVoice"));
    }

    @Test public void lockScreenAlarmHasExplicitSnoozeAndDismiss() throws Exception {
        String activity = source("AlarmRingingActivity.java");
        assertTrue(activity.contains("setShowWhenLocked(true)"));
        assertTrue(activity.contains("setTurnScreenOn(true)"));
        assertTrue(activity.contains("Snooze 10 min"));
        assertTrue(activity.contains("Dismiss"));
        assertFalse(activity.contains("WebView"));
    }

    @Test public void offlineActionsRemainOrderedAndRefreshAuthentication() throws Exception {
        String worker = source("AlarmActionSyncWorker.java");
        String store = source("AlarmStore.java");
        assertTrue(worker.contains("ExistingWorkPolicy.APPEND_OR_REPLACE"));
        assertTrue(worker.contains("client_revision"));
        assertTrue(worker.contains("scheduled_at"));
        assertTrue(worker.contains("/auth/refresh"));
        assertTrue(store.contains("local.revision > remote.revision"));
    }

    @Test public void manifestDeclaresOnlyAlarmRequiredNativeAccess() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        assertTrue(manifest.contains("android.permission.SCHEDULE_EXACT_ALARM"));
        assertTrue(manifest.contains("android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"));
        assertTrue(manifest.contains("android:name=\".AlarmRingingService\""));
        assertTrue(manifest.contains("android:name=\".AlarmRingingActivity\""));
        assertTrue(manifest.contains("android:name=\".AlarmReceiver\""));
    }

    private static String source(String file) throws Exception {
        return read("src/main/java/com/autoai/app/" + file);
    }

    private static String read(String path) throws Exception {
        return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
    }
}
