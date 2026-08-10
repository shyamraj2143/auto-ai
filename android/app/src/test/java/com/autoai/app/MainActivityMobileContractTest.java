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

    private static String source(String relative) throws Exception {
        return new String(Files.readAllBytes(Paths.get(relative)), StandardCharsets.UTF_8);
    }
}
