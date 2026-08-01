package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class PushTokenRegistrarTest {
    @Test public void firebaseInstallationIdIsAcceptedAsDirectSendTarget() {
        assertTrue(PushTokenRegistrar.isUsablePushTarget("firebase-installation-id"));
    }

    @Test public void installationMigrationUsesTheEnabledDirectSendApi() throws Exception {
        String worker = source("FcmInstallationMigrationWorker.java");
        String registrar = source("PushTokenRegistrar.java");
        String activity = source("MainActivity.java");
        String plugin = source("AutoAiCallsPlugin.java");
        String manifest = new String(
            Files.readAllBytes(Paths.get("src/main/AndroidManifest.xml")),
            StandardCharsets.UTF_8
        );

        assertTrue(manifest.contains("firebase_messaging_installation_id_enabled"));
        assertTrue(worker.contains("FirebaseMessaging.getInstance().register()"));
        assertTrue(worker.contains("registerInstallationBlocking(context, currentFid, rotatingFromHash)"));
        assertTrue(registrar.contains("registerUserDevice(context, cleanInstallationId, cleanInstallationId"));
        assertTrue(registrar.contains("FirebaseMessaging.getInstance().register()"));
        assertTrue(activity.contains("PushTokenRegistrar.refreshCurrentRegistrationAsync(this)"));
        assertTrue(plugin.contains("FirebaseInstallations.getInstance().getId()"));
        assertFalse(worker.contains("getToken()"));
        assertFalse(registrar.contains("getToken()"));
        assertFalse(plugin.contains("getToken()"));
        assertFalse(worker.contains(".unregister()"));
        assertFalse(worker.contains("installations.delete()"));
    }

    private static String source(String name) throws Exception {
        return new String(
            Files.readAllBytes(Paths.get("src/main/java/com/autoai/app/" + name)),
            StandardCharsets.UTF_8
        );
    }
}
