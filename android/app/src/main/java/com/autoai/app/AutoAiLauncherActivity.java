package com.autoai.app;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;

/** Production launcher: startup-safe native registration + update delivery before React workspace rendering. */
public final class AutoAiLauncherActivity extends BridgeActivity {
    private static final String TAG = "AutoAiLauncher";
    private AppUpdateCoordinator updateCoordinator;
    private final AppUpdateCoordinator.Listener updateListener = this::handleUpdateSnapshot;
    private boolean installerHandoff;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        safeRegister("secure storage", AutoAiSecureStoragePlugin.class);
        safeRegister("google auth", AutoAiGoogleAuthPlugin.class);
        safeRegister("live speech", AutoAiLiveSpeechPlugin.class);
        safeRegister("live audio", LiveAudioPlugin.class);
        safeRegister("live vision", LiveVisionPlugin.class);
        safeRegister("screen capture", ScreenCapturePlugin.class);
        safeRegister("calls", AutoAiCallsPlugin.class);
        safeRegister("updates", AutoAiUpdatePlugin.class);
        safeRegister("notifications", AutoAiNotificationsPlugin.class);
        safeRegister("alarms", AutoAiAlarmPlugin.class);
        safeRegister("service capabilities", AutoAiServiceCapabilitiesPlugin.class);

        try {
            super.onCreate(savedInstanceState);
        } catch (Throwable error) {
            Log.e(TAG, "Capacitor startup failed", error);
            showRecoveryScreen();
            return;
        }

        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
            getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
                @Override public void handleOnBackPressed() {
                    WebView webView = getBridge() == null ? null : getBridge().getWebView();
                    if (webView != null && webView.canGoBack()) webView.goBack();
                    else finish();
                }
            });
            WebView webView = getBridge().getWebView();
            webView.setNestedScrollingEnabled(true);
            webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
            WebSettings settings = webView.getSettings();
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setJavaScriptCanOpenWindowsAutomatically(true);
            settings.setSupportMultipleWindows(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()));
            webView.setWebChromeClient(new BridgeWebChromeClient(getBridge()));
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        } catch (Throwable error) {
            Log.e(TAG, "Optional WebView hardening failed; keeping default Capacitor WebView", error);
        }

        initializeUpdateChecks();
    }

    private void initializeUpdateChecks() {
        try {
            updateCoordinator = AppUpdateCoordinator.get(this);
            updateCoordinator.addListener(updateListener);
            updateCoordinator.check(true);
        } catch (Throwable error) {
            Log.e(TAG, "Update subsystem unavailable; continuing without updater", error);
        }
    }

    private void handleUpdateSnapshot(AppUpdateCoordinator.Snapshot snapshot) {
        try {
            if (snapshot == null || snapshot.metadata == null || !AppUpdateCoordinator.hasPendingUpdate(snapshot.metadata)) return;
            if (snapshot.state == AppUpdateCoordinator.State.AVAILABLE && !updateCoordinator.isDirectUpdateActive()) {
                updateCoordinator.startDirectUpdate();
                return;
            }
            if (snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL && updateCoordinator.isDirectUpdateActive()) {
                runOnUiThread(this::handoffVerifiedInstaller);
            }
        } catch (Throwable error) {
            Log.e(TAG, "Non-fatal update handoff failure", error);
        }
    }

    private void handoffVerifiedInstaller() {
        try {
            if (isFinishing() || installerHandoff || updateCoordinator == null) return;
            if (!updateCoordinator.canInstallPackages()) {
                updateCoordinator.requireInstallPermission();
                startActivity(updateCoordinator.installPermissionIntent());
                return;
            }
            Intent installer = updateCoordinator.installerIntent();
            if (installer == null) return;
            installerHandoff = true;
            startActivity(installer);
        } catch (Throwable error) {
            installerHandoff = false;
            Log.e(TAG, "Unable to open verified Android installer", error);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        try {
            installerHandoff = false;
            if (updateCoordinator == null) initializeUpdateChecks();
            else {
                updateCoordinator.refreshInstallState();
                updateCoordinator.check(true);
            }
        } catch (Throwable error) {
            Log.e(TAG, "Non-fatal foreground update check failure", error);
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (updateCoordinator != null) updateCoordinator.removeListener(updateListener);
        } catch (Throwable error) {
            Log.e(TAG, "Non-fatal update listener cleanup failure", error);
        }
        super.onDestroy();
    }

    private void safeRegister(String name, Class<? extends Plugin> plugin) {
        try {
            registerPlugin(plugin);
        } catch (Throwable error) {
            Log.e(TAG, "Disabled native integration: " + name, error);
        }
    }

    private void showRecoveryScreen() {
        try {
            WebView recovery = new WebView(this);
            recovery.setBackgroundColor(Color.rgb(5, 10, 18));
            recovery.getSettings().setJavaScriptEnabled(false);
            setContentView(recovery);
            String html = "<html><body style='background:#050a12;color:#fff;font-family:sans-serif;padding:28px'>"
                + "<h2>Auto-AI is recovering</h2>"
                + "<p>A native integration failed during startup. Your data is not being deleted.</p>"
                + "<p>Please reopen the app after the recovery update is installed.</p>"
                + "</body></html>";
            recovery.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        } catch (Throwable ignored) {
        }
    }
}
