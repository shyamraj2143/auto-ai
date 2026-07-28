package com.autoai.app;

import static org.junit.Assert.*;

import org.junit.Test;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Arrays;

public class CallingPermissionCoordinatorTest {
    @Test public void freshInstallRequiresOnboarding() { assertTrue(CallingPermissionCoordinator.shouldOnboard(-1, 37, false)); }
    @Test public void completedCurrentVersionDoesNotRequireOnboarding() { assertFalse(CallingPermissionCoordinator.shouldOnboard(37, 37, false)); }
    @Test public void newVersionRequiresOnboarding() { assertTrue(CallingPermissionCoordinator.shouldOnboard(36, 37, false)); }
    @Test public void receiverFlagRequiresCheck() { assertTrue(CallingPermissionCoordinator.shouldOnboard(37, 37, true)); }
    @Test public void notificationsAreRuntimeOnlyFromApi33() {
        assertFalse(CallingPermissionCoordinator.runtimeNotificationRequired(32));
        assertTrue(CallingPermissionCoordinator.runtimeNotificationRequired(33));
    }
    @Test public void bluetoothIsRuntimeOnlyFromApi31() {
        assertFalse(CallingPermissionCoordinator.runtimeBluetoothRequired(30));
        assertTrue(CallingPermissionCoordinator.runtimeBluetoothRequired(31));
    }
    @Test public void allRequirementsReady() { assertEquals(CallingPermissionCoordinator.Status.READY, CallingPermissionCoordinator.readinessFor(ready())); }
    @Test public void cameraDenialKeepsAudioLimited() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("camera", CallingPermissionCoordinator.ItemState.DENIED);
        assertEquals(CallingPermissionCoordinator.Status.LIMITED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void fullScreenDenialIsLimited() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("fullScreen", CallingPermissionCoordinator.ItemState.SPECIAL_ACCESS_REQUIRED);
        assertEquals(CallingPermissionCoordinator.Status.LIMITED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void notificationDenialIsBlocked() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("notifications", CallingPermissionCoordinator.ItemState.DENIED);
        assertEquals(CallingPermissionCoordinator.Status.BLOCKED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void lowIncomingChannelIsBlocked() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("incomingChannel", CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED);
        assertEquals(CallingPermissionCoordinator.Status.BLOCKED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void microphoneDenialIsBlocked() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("microphone", CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED);
        assertEquals(CallingPermissionCoordinator.Status.BLOCKED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void approvedUserPermissionKeysContainNoDiagnostics() {
        assertEquals(Arrays.asList("notifications","incomingChannel","microphone","camera","bluetooth","fullScreen","backgroundActivity"), CallingPermissionCoordinator.USER_PERMISSION_KEYS);
    }
    @Test public void restrictedBackgroundIsBlocked() {
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("backgroundActivity", CallingPermissionCoordinator.backgroundState(true, false));
        assertEquals(CallingPermissionCoordinator.Status.BLOCKED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void optimizedBackgroundIsLimitedNotDenied() {
        assertEquals(CallingPermissionCoordinator.ItemState.LIMITED, CallingPermissionCoordinator.backgroundState(false, false));
        Map<String, CallingPermissionCoordinator.ItemState> items = ready();
        items.put("backgroundActivity", CallingPermissionCoordinator.backgroundState(false, false));
        assertEquals(CallingPermissionCoordinator.Status.LIMITED, CallingPermissionCoordinator.readinessFor(items));
    }
    @Test public void allowlistedBackgroundIsUnrestricted() {
        assertEquals(CallingPermissionCoordinator.ItemState.GRANTED, CallingPermissionCoordinator.backgroundState(false, true));
    }
    @Test public void internalDiagnosticsRemainSeparate() {
        Map<String, CallingPermissionCoordinator.DiagnosticState> diagnostics = new LinkedHashMap<>();
        diagnostics.put("pushRegistration", CallingPermissionCoordinator.DiagnosticState.UNAVAILABLE);
        CallingPermissionCoordinator.Snapshot snapshot = new CallingPermissionCoordinator.Snapshot(CallingPermissionCoordinator.Status.READY, ready(), diagnostics);
        assertTrue(snapshot.permissionItems.keySet().containsAll(CallingPermissionCoordinator.USER_PERMISSION_KEYS));
        assertEquals(CallingPermissionCoordinator.DiagnosticState.UNAVAILABLE, snapshot.internalDiagnostics.get("pushRegistration"));
        assertEquals(CallingPermissionCoordinator.Status.READY, snapshot.permissionStatus);
    }

    private Map<String, CallingPermissionCoordinator.ItemState> ready() {
        Map<String, CallingPermissionCoordinator.ItemState> items = new LinkedHashMap<>();
        for (String key : CallingPermissionCoordinator.USER_PERMISSION_KEYS)
            items.put(key, CallingPermissionCoordinator.ItemState.GRANTED);
        return items;
    }
}
