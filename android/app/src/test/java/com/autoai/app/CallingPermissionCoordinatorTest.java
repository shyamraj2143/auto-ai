package com.autoai.app;

import static org.junit.Assert.*;

import org.junit.Test;
import java.util.LinkedHashMap;
import java.util.Map;

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

    private Map<String, CallingPermissionCoordinator.ItemState> ready() {
        Map<String, CallingPermissionCoordinator.ItemState> items = new LinkedHashMap<>();
        for (String key : new String[]{"notifications","incomingChannel","microphone","camera","bluetooth","fullScreen","battery","firebase","playServices","foregroundService","telecom"})
            items.put(key, CallingPermissionCoordinator.ItemState.GRANTED);
        return items;
    }
}
