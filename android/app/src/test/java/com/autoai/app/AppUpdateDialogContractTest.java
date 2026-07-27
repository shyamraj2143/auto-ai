package com.autoai.app;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class AppUpdateDialogContractTest {
    @Test public void updateStatesHaveExplicitPrimaryActions() {
        assertEquals("Update Now", AppUpdateDialog.actionForState(AppUpdateCoordinator.State.AVAILABLE));
        assertEquals("Downloading...", AppUpdateDialog.actionForState(AppUpdateCoordinator.State.DOWNLOADING));
        assertEquals("Install Now", AppUpdateDialog.actionForState(AppUpdateCoordinator.State.READY_TO_INSTALL));
        assertEquals("Allow Installation", AppUpdateDialog.actionForState(AppUpdateCoordinator.State.INSTALL_PERMISSION_REQUIRED));
        assertEquals("Retry", AppUpdateDialog.actionForState(AppUpdateCoordinator.State.FAILED));
    }

    @Test public void dialogBrandAndTouchTargetsStayBounded() {
        assertTrue(AppUpdateDialog.DIALOG_LOGO_DP <= 48);
        assertTrue(AppUpdateDialog.ACTION_HEIGHT_DP >= 48);
        assertTrue(AppUpdateDialog.DIALOG_MAX_WIDTH_DP <= 440);
    }
}
