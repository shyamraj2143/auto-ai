package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class TelecomFallbackContractTest {
    @Test public void registrationDoesNotUseCellularIdentityPermissionsOrGetPhoneAccount() throws Exception {
        String bridge = source("AutoAiTelecomBridge.java");
        String manifest = read("src/main/AndroidManifest.xml");
        assertFalse(bridge.contains("getPhoneAccount("));
        assertFalse(manifest.contains("READ_PHONE_NUMBERS"));
        assertFalse(manifest.contains("READ_PHONE_STATE"));
        assertTrue(bridge.contains("getOwnSelfManagedPhoneAccounts()"));
        assertTrue(bridge.contains("Build.VERSION_CODES.TIRAMISU"));
        assertTrue(bridge.contains("registerPhoneAccount(account)"));
    }

    @Test public void api33VerifiesTheExactOwnedSelfManagedHandle() throws Exception {
        String bridge = source("AutoAiTelecomBridge.java");
        assertTrue(bridge.contains("containsExactHandle(manager.getOwnSelfManagedPhoneAccounts(), handle)"));
        assertTrue(bridge.contains("handles.contains(expected)"));
    }

    @Test public void api26Through32TrustSuccessfulRegistrationWithoutReadback() throws Exception {
        String bridge = source("AutoAiTelecomBridge.java");
        assertFalse(bridge.contains("getPhoneAccount("));
        assertTrue(bridge.contains("Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU"));
        assertTrue(bridge.contains("return alreadyRegistered ? TelecomRegistrationResult.ALREADY_REGISTERED"));
    }

    @Test public void telecomFailureCannotTerminateWebRtcService() throws Exception {
        String service = source("CallForegroundService.java");
        assertTrue(service.contains("continuing native WebRTC"));
        assertTrue(service.contains("TelecomMode.DEGRADED"));
        assertFalse(service.contains("failStart(activeCallId, \"TELECOM_REGISTRATION_FAILED\")"));
        assertFalse(service.contains("TELECOM_REGISTRATION_FAILED"));
    }

    @Test public void telecomSecurityExceptionIsTypedAndDoesNotFailTheCall() throws Exception {
        String bridge = source("AutoAiTelecomBridge.java");
        String service = source("CallForegroundService.java");
        assertTrue(bridge.contains("catch (SecurityException error)"));
        assertTrue(bridge.contains("TelecomCallResult.SECURITY_EXCEPTION"));
        assertFalse(service.contains("failStart(activeCallId, \"TELECOM"));
        assertTrue(service.contains("return START_STICKY"));
    }

    @Test public void telecomReportingKeepsNativeNotificationFallback() throws Exception {
        String manager = source("CallNotificationManager.java");
        String bridge = source("AutoAiTelecomBridge.java");
        assertTrue(manager.contains("TelecomCallResult telecomResult"));
        assertTrue(manager.contains("NotificationCompat.Builder"));
        assertTrue(manager.indexOf("manager.notify(incomingNotificationId, notification)")
            < manager.indexOf("AutoAiTelecomBridge.reportIncomingCall(context, data)"));
        assertTrue(bridge.contains("catch (SecurityException error)"));
        assertTrue(bridge.contains("catch (IllegalArgumentException error)"));
        assertTrue(bridge.contains("catch (UnsupportedOperationException error)"));
    }

    @Test public void callStateColorsFollowMediaSemantics() throws Exception {
        String activity = source("ActiveCallActivity.java");
        assertTrue(activity.contains("case SERVICE_READY: setStatus(\"Preparing secure call…\", 0xFF22D3EE)"));
        assertTrue(activity.contains("case SIGNALING_CONNECTED: setStatus(\"Connecting media…\", 0xFF22D3EE)"));
        assertTrue(activity.contains("case MEDIA_CONNECTED:"));
        assertTrue(activity.contains("setStatus(\"Connected\", 0xFF22C55E)"));
    }

    @Test public void acceptWaitsForServiceReadyThenLaunchesActiveCallActivity() throws Exception {
        String dispatcher = source("CallIntentDispatcher.java");
        assertTrue(dispatcher.contains("CallForegroundService.SERVICE_READY.equals(status)"));
        assertTrue(dispatcher.contains("launchActive(context"));
        assertTrue(dispatcher.contains("new Intent(context, ActiveCallActivity.class)"));
        assertTrue(dispatcher.contains("ACTIVE_CALL_ACTIVITY_OPENED"));
    }

    @Test public void terminalCleanupRemovesIncomingAndOngoingNotifications() throws Exception {
        String manager = source("CallNotificationManager.java");
        assertTrue(manager.contains("cancelAllForTerminalCall"));
        assertTrue(manager.contains("cancelAllForCall(context, callId)"));
        assertTrue(manager.contains("notificationManager.cancel(notificationId(callId) + 100000)"));
    }

    @Test public void manifestDeclaresProtectedExportedConnectionService() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        assertTrue(manifest.contains("android:name=\".AutoAiConnectionService\""));
        assertTrue(manifest.contains("android:exported=\"true\""));
        assertTrue(manifest.contains("android:permission=\"android.permission.BIND_TELECOM_CONNECTION_SERVICE\""));
        assertTrue(manifest.contains("android:name=\"android.telecom.ConnectionService\""));
    }

    private static String source(String file) throws Exception { return read("src/main/java/com/autoai/app/" + file); }
    private static String read(String file) throws Exception { return new String(Files.readAllBytes(Paths.get(file)), StandardCharsets.UTF_8); }
}
