package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class PushTokenRegistrarTest {
    @Test public void firebaseInstallationIdIsNeverAcceptedAsMessagingToken() {
        assertFalse(PushTokenRegistrar.isUsableFcmToken("same-id", "same-id"));
        assertFalse(PushTokenRegistrar.isUsableFcmToken("  ", "installation-id"));
        assertTrue(PushTokenRegistrar.isUsableFcmToken("real-fcm-token", "installation-id"));
    }

    @Test public void installationMigrationFetchesAndRegistersTheRealMessagingToken() throws Exception {
        String worker = source("FcmInstallationMigrationWorker.java");
        String registrar = source("PushTokenRegistrar.java");
        String activity = source("MainActivity.java");

        assertTrue(worker.contains("FirebaseMessaging.getInstance().getToken()"));
        assertTrue(worker.contains("registerInstallationBlocking(context, newFid, newToken, oldHash)"));
        assertFalse(registrar.contains("registerUserDevice(context, cleanInstallationId, cleanInstallationId"));
        assertFalse(registrar.contains(".remove(LAST_FCM_TOKEN)"));
        assertTrue(activity.contains("PushTokenRegistrar.refreshCurrentTokenAsync(this)"));
    }

    private static String source(String name) throws Exception {
        return new String(
            Files.readAllBytes(Paths.get("src/main/java/com/autoai/app/" + name)),
            StandardCharsets.UTF_8
        );
    }
}
