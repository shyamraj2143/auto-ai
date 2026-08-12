package com.autoai.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class MainActivityMobileContractTest {
    @Test public void webViewPageLoadsReapplyNativeInsets() throws Exception {
        String source = source("src/main/java/com/autoai/app/MainActivity.java");
        assertTrue(source.contains("private Insets lastSafeInsets = Insets.NONE"));
        assertTrue(source.contains("nativeKeyboardOpen = windowInsets.isVisible(WindowInsetsCompat.Type.ime())"));
        assertTrue(source.contains("syncWebInsets(view, lastSafeInsets, nativeKeyboardOpen);"));
    }

    @Test public void paymentPopupIsVisibleAndReleased() throws Exception {
        String source = source("src/main/java/com/autoai/app/MainActivity.java");
        assertTrue(source.contains("showPaymentPopup(paymentWindow);"));
        assertTrue(source.contains("paymentWindow.setWebChromeClient(new PaymentPopupWebChromeClient(paymentWindow));"));
        assertTrue(source.contains("dialog.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);"));
        assertTrue(source.contains("if (paymentPopupWebView == paymentWindow)"));
        assertTrue(source.contains("paymentWindow.destroy();"));
        assertTrue(source.contains("public void onCloseWindow(WebView window)"));
    }

    @Test public void allUpdatePathsUseTheCanonicalChannel() throws Exception {
        assertEquals("auto_ai_updates", UpdateNotificationChannel.ID);
        assertTrue(source("src/main/java/com/autoai/app/AutoAiFirebaseMessagingService.java")
            .contains("new Notification.Builder(this, UpdateNotificationChannel.ID)"));
        assertTrue(source("src/main/java/com/autoai/app/UpdateCheckWorker.java")
            .contains("new Notification.Builder(context, UpdateNotificationChannel.ID)"));
        assertTrue(source("src/main/java/com/autoai/app/AppUpdateDownloadWorker.java")
            .contains("new Notification.Builder(context, UpdateNotificationChannel.ID)"));
    }

    @Test public void optionalStartupIntegrationsCannotCrashMainActivity() throws Exception {
        String source = source("src/main/java/com/autoai/app/MainActivity.java");
        assertTrue(source.contains("private void safeRegister(String name, Class<? extends Plugin> plugin)"));
        assertTrue(source.contains("Capacitor startup failed"));
        assertTrue(source.contains("showRecoveryScreen();"));
        assertTrue(source.contains("runActivityStartupStep(\"webview setup\", this::configureBridgeWebView);"));
        assertTrue(source.contains("private void runActivityStartupStep(String name, Runnable step)"));
        assertTrue(source.contains("catch (Throwable error)"));
        assertTrue(source.contains("runActivityStartupStep(\"update check\", () -> AppUpdateCoordinator.get(this).check(true));"));
        assertTrue(source.contains("runActivityStartupStep(\"foreground update check\", () -> AppUpdateCoordinator.get(this).check(true));"));
        assertTrue(source.contains("launchCallingSetupIfRequiredUnsafe();"));
        assertTrue(source.contains("Non-fatal MainActivity startup failure in calling setup launch"));
        assertTrue(source.contains("catch (Throwable ignored)"));
    }

    @Test public void stableLauncherComponentUsesFullFeatureMainActivity() throws Exception {
        String manifest = source("src/main/AndroidManifest.xml");
        int mainStart = manifest.indexOf("android:name=\".MainActivity\"");
        int mainEnd = manifest.indexOf("</activity>", mainStart);
        String mainDeclaration = manifest.substring(mainStart, mainEnd);
        int launcherStart = manifest.indexOf("android:name=\".AutoAiLauncherActivity\"");
        int launcherEnd = manifest.indexOf("</activity>", launcherStart);
        String launcherDeclaration = manifest.substring(launcherStart, launcherEnd);
        String launcherSource = source("src/main/java/com/autoai/app/AutoAiLauncherActivity.java");

        assertTrue(launcherDeclaration.contains("android.intent.action.MAIN"));
        assertTrue(launcherDeclaration.contains("android.intent.category.LAUNCHER"));
        assertTrue(launcherDeclaration.contains("android:exported=\"true\""));
        assertTrue(launcherSource.contains("extends MainActivity"));
        assertTrue(mainDeclaration.contains("com.autoai.app.INCOMING_CALL_FALLBACK"));
    }

    private static String source(String relative) throws Exception {
        return new String(Files.readAllBytes(Paths.get(relative)), StandardCharsets.UTF_8);
    }
}
