package com.autoai.app;

import org.junit.Test;

import android.widget.ScrollView;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

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
        assertEquals("single-page-v4", AppUpdateDialog.UPDATE_DIALOG_LAYOUT_VERSION);
    }

    @Test public void dialogDeclaresNoScrollableContainer() {
        for (Field field : AppUpdateDialog.class.getDeclaredFields()) {
            assertTrue("Scrollable field: " + field.getName(), !ScrollView.class.isAssignableFrom(field.getType()));
        }
        for (Class<?> nested : AppUpdateDialog.class.getDeclaredClasses()) {
            assertTrue("Scrollable nested class: " + nested.getName(), !ScrollView.class.isAssignableFrom(nested));
            assertTrue(!nested.getSimpleName().contains("BoundedScrollView"));
        }
    }

    @Test public void densityCompactsBeforeSmallScreenCanClipActions() {
        assertEquals(AppUpdateDialog.Density.EXTRA_COMPACT, AppUpdateDialog.densityForHeightDp(568));
        assertEquals(AppUpdateDialog.Density.COMPACT, AppUpdateDialog.densityForHeightDp(640));
        assertEquals(AppUpdateDialog.Density.COMFORTABLE, AppUpdateDialog.densityForHeightDp(873));
    }

    @Test public void mandatoryDialogCannotBeDismissedOrBypassed() throws Exception {
        String source = new String(
            Files.readAllBytes(Paths.get("src/main/java/com/autoai/app/AppUpdateDialog.java")),
            StandardCharsets.UTF_8
        );
        assertTrue(source.contains("close.setVisibility(mandatory ? View.GONE : View.VISIBLE)"));
        assertTrue(source.contains("dialog.setCancelable(!mandatory)"));
        assertTrue(source.contains("dialog.setCanceledOnTouchOutside(!mandatory)"));
        assertTrue(source.contains("coordinator.current().metadata.mandatory"));
    }
}
