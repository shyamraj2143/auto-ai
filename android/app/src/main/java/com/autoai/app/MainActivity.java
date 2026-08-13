package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.graphics.Color;
import android.content.Context;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.provider.Settings;
import android.util.Rational;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.FileProvider;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Plugin;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";
    private static final int STARTUP_PERMISSION_REQUEST_CODE = 4101;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int MAX_DOWNLOAD_ATTEMPTS = 3;
    private static final long UPDATE_CHECK_INTERVAL_MS = 5L * 60L * 1000L;
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";
    private static final int NOTIFICATION_DESTINATION_MAX_ATTEMPTS = 120;

    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable updatePollRunnable = new Runnable() {
        @Override
        public void run() {
            checkForUpdate(false);
            mainHandler.postDelayed(this, UPDATE_CHECK_INTERVAL_MS);
        }
    };
    private ApkUpdate latestUpdate;
    private File pendingInstallFile;
    private DownloadProgress downloadProgress;
    private boolean updateDialogVisible;
    private boolean updateCheckRunning;
    private boolean waitingForInstallPermission;
    private long lastUpdateCheckAtMs;
    private long lastNativeRootBackAtMs;
    private final AtomicBoolean directInstallerHandoff = new AtomicBoolean(false);
    private final AppUpdateCoordinator.Listener directUpdateListener = this::handleDirectUpdateState;
    private AppUpdateDialog fallbackUpdateDialog;
    private Insets lastSafeInsets = Insets.NONE;
    private boolean nativeKeyboardOpen;
    private AlertDialog paymentPopupDialog;
    private WebView paymentPopupWebView;
    private boolean callingSetupVisible;
    private int notificationDestinationDispatchAttempts;
    private final Runnable notificationDestinationDispatch = new Runnable() {
        @Override public void run() {
            if (NotificationDeepLink.dispatchPending(MainActivity.this)) {
                notificationDestinationDispatchAttempts = 0;
                return;
            }
            if (!NotificationDeepLink.hasPending(MainActivity.this)) {
                notificationDestinationDispatchAttempts = 0;
                return;
            }
            notificationDestinationDispatchAttempts++;
            if (notificationDestinationDispatchAttempts < NOTIFICATION_DESTINATION_MAX_ATTEMPTS) {
                mainHandler.postDelayed(this, 250L);
            }
        }
    };

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
        runActivityStartupStep("webview setup", this::configureBridgeWebView);
        runActivityStartupStep("startup runtime permissions", this::requestMissingStartupPermissions);
        runActivityStartupStep("call notification channels", () -> CallNotificationManager.createChannels(this));
        runActivityStartupStep("relationship notification channel", () -> AutoAiFirebaseMessagingService.createRelationshipNotificationChannel(this));
        runActivityStartupStep("firebase messaging registration", this::registerFirebaseMessagingToken);
        runActivityStartupStep("update scheduler", () -> UpdateCheckScheduler.cancelLegacy(this));
        runActivityStartupStep("update listener", () -> AppUpdateCoordinator.get(this).addListener(directUpdateListener));
        // A cold launch must not reuse the normal cooldown: every successful main
        // deployment publishes a required APK and must be discovered immediately.
        runActivityStartupStep("update check", () -> AppUpdateCoordinator.get(this).check(true));
        runActivityStartupStep("update intent", () -> dispatchUpdateIntent(getIntent()));
        runActivityStartupStep("push device sync", this::syncPushDeviceIfAuthenticated);
        runActivityStartupStep("incoming call intent", () -> dispatchIncomingCallIntent(getIntent()));
        runActivityStartupStep("notification destination", () -> dispatchNotificationDestination(getIntent()));
    }

    /**
     * Request only Android runtime permissions that are actually declared by the
     * production APK. This deliberately bypasses Capacitor permission aliases so
     * a plugin cannot crash before its permission group has been initialized.
     * Android will show each permission prompt only when it is still required.
     */
    private void requestMissingStartupPermissions() {
        if (isFinishing() || isDestroyed()) return;
        java.util.ArrayList<String> missing = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.CAMERA);
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (!missing.isEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), STARTUP_PERMISSION_REQUEST_CODE);
        }
    }

    private void configureBridgeWebView() {
        if (getBridge() == null || getBridge().getWebView() == null) return;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchNativeBack();
            }
        });

        WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets safeInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            lastSafeInsets = safeInsets;
            nativeKeyboardOpen = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            syncWebInsets(webView, lastSafeInsets, nativeKeyboardOpen);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
        webView.setNestedScrollingEnabled(true);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(browserLikeUserAgent(settings.getUserAgentString()));
        getBridge().setWebViewClient(new AutoAiWebViewClient(getBridge()));
        webView.setWebChromeClient(new AutoAiWebChromeClient(getBridge()));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
    }

    private void runActivityStartupStep(String name, Runnable step) {
        try {
            step.run();
        } catch (Throwable error) {
            Log.e(TAG, "Non-fatal MainActivity startup failure in " + name, error);
        }
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
                + "<p>Please install the latest update and reopen the app.</p>"
                + "</body></html>";
            recovery.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        } catch (Throwable ignored) {
        }
    }

    private void syncWebInsets(WebView webView, Insets insets, boolean keyboardOpen) {
        float density = getResources().getDisplayMetrics().density;
        String script = "(function(){var r=document.documentElement;r.dataset.nativeInsets='true';r.style.setProperty('--native-safe-top','"
            + (insets.top / density) + "px');r.style.setProperty('--native-safe-right','"
            + (insets.right / density) + "px');r.style.setProperty('--native-safe-bottom','"
            + (insets.bottom / density) + "px');r.style.setProperty('--native-safe-left','"
            + (insets.left / density) + "px');r.classList.toggle('autoai-keyboard-open',"
            + keyboardOpen + ");})()";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private void dispatchNativeBack() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) {
            handleUnconsumedNativeBack(null);
            return;
        }
        String backEventId = UUID.randomUUID().toString();
        String script = "(function(){try{" +
            "var e=new CustomEvent('auto-ai-native-back',{cancelable:true,detail:{backEventId:'" + backEventId + "'}});" +
            "var handled=!window.dispatchEvent(e);" +
            "return handled?'handled':(window.location.pathname==='/hub'?'root':'unhandled');" +
            "}catch(e){return 'unhandled';}})()";
        webView.evaluateJavascript(script, result -> {
            String value = result == null ? "" : result.replace("\"", "");
            if (!"handled".equals(value)) handleUnconsumedNativeBack(webView);
        });
    }

    // The remainder of this activity intentionally remains unchanged from main.
