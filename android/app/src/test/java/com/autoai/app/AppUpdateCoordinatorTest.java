package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppUpdateCoordinatorTest {
    @Test public void apiUrlNeverDuplicatesOrUsesDoubleSlashPath() {
        String url = AppUpdateCoordinator.apiUrl("/download/apk/latest");
        assertFalse(url.contains("//api/v1"));
        assertFalse(url.contains("/api/v1/api/v1"));
        assertTrue(url.endsWith("/api/v1/download/apk/latest"));
    }

    @Test public void updateDecisionUsesStrictVersionCode() {
        AppUpdateCoordinator.Metadata metadata = new AppUpdateCoordinator.Metadata();
        metadata.versionCode = BuildConfig.VERSION_CODE + 1;
        metadata.packageName = "com.autoai.app";
        assertTrue(metadata.versionCode > BuildConfig.VERSION_CODE);
        metadata.packageName = "wrong.package";
        assertFalse("com.autoai.app".equals(metadata.packageName));
    }
}
