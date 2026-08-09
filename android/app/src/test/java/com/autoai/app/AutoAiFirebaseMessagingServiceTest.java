package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AutoAiFirebaseMessagingServiceTest {
    @Test
    public void pushedUpdateNotifiesOnlyForANewerAvailableVerifiedState() {
        int installedVersion = 100;

        assertTrue(AutoAiFirebaseMessagingService.shouldNotifyForVerifiedUpdate(
            snapshot(AppUpdateCoordinator.State.AVAILABLE, 101), installedVersion
        ));
        assertTrue(AutoAiFirebaseMessagingService.shouldNotifyForVerifiedUpdate(
            snapshot(AppUpdateCoordinator.State.READY_TO_INSTALL, 101), installedVersion
        ));
        assertFalse(AutoAiFirebaseMessagingService.shouldNotifyForVerifiedUpdate(
            snapshot(AppUpdateCoordinator.State.CHECKING, 101), installedVersion
        ));
        assertFalse(AutoAiFirebaseMessagingService.shouldNotifyForVerifiedUpdate(
            snapshot(AppUpdateCoordinator.State.AVAILABLE, installedVersion), installedVersion
        ));
    }

    @Test
    public void pushedUpdateListenerStopsForTerminalStates() {
        assertTrue(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.UP_TO_DATE));
        assertTrue(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.FAILED));
        assertTrue(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.INSTALLED));
        assertTrue(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.IDLE));
        assertFalse(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.CHECKING));
        assertFalse(AutoAiFirebaseMessagingService.isTerminalUpdateCheckState(AppUpdateCoordinator.State.AVAILABLE));
    }

    private static AppUpdateCoordinator.Snapshot snapshot(AppUpdateCoordinator.State state, int versionCode) {
        AppUpdateCoordinator.Metadata metadata = new AppUpdateCoordinator.Metadata();
        metadata.versionCode = versionCode;
        return new AppUpdateCoordinator.Snapshot(state, metadata, 0, 0, "", "");
    }
}
