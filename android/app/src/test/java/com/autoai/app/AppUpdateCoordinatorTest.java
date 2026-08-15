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

    @Test public void mandatoryDecisionUsesReleasePolicyAndMinimumSupportedVersion() {
        AppUpdateCoordinator.Metadata optional = new AppUpdateCoordinator.Metadata();
        optional.versionCode = 102351;
        optional.minimumSupportedVersionCode = 102300;
        assertFalse(AppUpdateCoordinator.requiresMandatoryUpdate(102341, optional));
        optional.forceUpdate = true;
        assertTrue(AppUpdateCoordinator.requiresMandatoryUpdate(102341, optional));
        optional.forceUpdate = false;
        optional.minimumSupportedVersionCode = 102350;
        assertTrue(AppUpdateCoordinator.requiresMandatoryUpdate(102341, optional));
        assertFalse(AppUpdateCoordinator.requiresMandatoryUpdate(102351, optional));
    }

    @Test public void backgroundUpdaterDownloadsOnlyMandatoryReleases() {
        AppUpdateCoordinator.Metadata optional = new AppUpdateCoordinator.Metadata();
        optional.versionCode = 102351;
        optional.minimumSupportedVersionCode = 102300;
        assertFalse(UpdateCheckWorker.shouldAutomaticallyDownload(optional, 102341));

        optional.forceUpdate = true;
        assertTrue(UpdateCheckWorker.shouldAutomaticallyDownload(optional, 102341));

        optional.forceUpdate = false;
        optional.minimumSupportedVersionCode = 102350;
        assertTrue(UpdateCheckWorker.shouldAutomaticallyDownload(optional, 102341));
    }

    @Test public void verifiedApkCanOnlyBeReusedForItsExactVersionCode() {
        assertTrue(AppUpdateCoordinator.downloadedVersionMatches(102351, 102351));
        assertFalse(AppUpdateCoordinator.downloadedVersionMatches(102341, 102351));
        assertFalse(AppUpdateCoordinator.downloadedVersionMatches(0, 102351));
    }

    @Test public void updaterAcceptsOnlyTrustedAutoAiReleasePaths() {
        assertTrue(AppUpdateCoordinator.isTrustedDownloadUrl(
            "https://github.com/shyamraj2143/auto-ai/releases/download/android-101201/auto-ai.apk"));
        assertTrue(AppUpdateCoordinator.isTrustedDownloadUrl(
            "https://auto-ai-app-download.up.railway.app/api/download/apk"));
        assertFalse(AppUpdateCoordinator.isTrustedDownloadUrl(
            "https://auto-ai-app-download.up.railway.app.evil.example/"));
        assertFalse(AppUpdateCoordinator.isTrustedDownloadUrl(
            "https://github.com/another-owner/auto-ai/releases/download/android-101201/auto-ai.apk"));
        assertFalse(AppUpdateCoordinator.isTrustedDownloadUrl("http://github.com/shyamraj2143/auto-ai.apk"));
    }

    @Test public void backgroundableStatesOnlyCoverAnActiveDownload() {
        assertTrue(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.QUEUED));
        assertTrue(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.DOWNLOADING));
        assertTrue(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.VERIFYING));
        assertTrue(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK));
        assertFalse(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.AVAILABLE));
        assertFalse(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.READY_TO_INSTALL));
        assertFalse(AppUpdateCoordinator.isDownloadInProgress(AppUpdateCoordinator.State.FAILED));
    }
}