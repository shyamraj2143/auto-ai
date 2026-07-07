package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.google.firebase.messaging.FirebaseMessaging;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int MAX_DOWNLOAD_ATTEMPTS = 3;
    private static final long UPDATE_CHECK_INTERVAL_MS = 5L * 60L * 1000L;
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 1002;
    private static final String UPDATE_NOTIFICATION_CHANNEL_ID = "auto_ai_updates";
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";

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

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AutoAiSecureStoragePlugin.class);
        registerPlugin(AutoAiGoogleAuthPlugin.class);
        registerPlugin(AutoAiLiveSpeechPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        webView.setNestedScrollingEnabled(true);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(true);
        settings.setUserAgentString(browserLikeUserAgent(settings.getUserAgentString()));
        getBridge().setWebViewClient(new AutoAiWebViewClient(getBridge()));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        createUpdateNotificationChannel();
        requestNotificationPermissionIfNeeded();
        registerFirebaseMessagingToken();
        UpdateCheckScheduler.schedule(this);
        checkForUpdate(true);
        startUpdatePolling();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (waitingForInstallPermission && pendingInstallFile != null && canRequestPackageInstalls()) {
            waitingForInstallPermission = false;
            openPackageInstaller(pendingInstallFile);
            return;
        }
        checkForUpdate(false);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        mainHandler.removeCallbacks(updatePollRunnable);
        updateExecutor.shutdownNow();
    }

    private void startUpdatePolling() {
        mainHandler.removeCallbacks(updatePollRunnable);
        mainHandler.postDelayed(updatePollRunnable, UPDATE_CHECK_INTERVAL_MS);
    }

    private void registerFirebaseMessagingToken() {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful()) {
                    PushTokenRegistrar.registerAsync(this, task.getResult());
                }
            });
        } catch (Exception ignored) {
            // Firebase is optional until google-services.json is configured.
        }
    }

    private String browserLikeUserAgent(String userAgent) {
        if (userAgent == null || userAgent.trim().isEmpty()) return userAgent;
        return userAgent
            .replace("; wv", "")
            .replace(" wv", "")
            .replace("Version/4.0 ", "");
    }

    private boolean openPaymentIntent(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        if ("intent".equals(scheme)) {
            return openParsedIntent(uri.toString());
        }
        if (!isPaymentScheme(scheme)) {
            return false;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Payment app not found.", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private boolean openParsedIntent(String url) {
        try {
            Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            try {
                startActivity(intent);
                return true;
            } catch (ActivityNotFoundException error) {
                String fallbackUrl = intent.getStringExtra("browser_fallback_url");
                if (fallbackUrl != null && !fallbackUrl.trim().isEmpty()) {
                    getBridge().getWebView().loadUrl(fallbackUrl);
                    return true;
                }
                Toast.makeText(this, "Payment app not found.", Toast.LENGTH_SHORT).show();
                return true;
            }
        } catch (Exception ignored) {
            return false;
        }
    }

    private boolean isPaymentScheme(String scheme) {
        return "upi".equals(scheme)
            || "tez".equals(scheme)
            || "phonepe".equals(scheme)
            || "paytmmp".equals(scheme)
            || "gpay".equals(scheme)
            || "bhim".equals(scheme);
    }

    private class AutoAiWebViewClient extends BridgeWebViewClient {
        private final Bridge bridge;

        AutoAiWebViewClient(Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            return openPaymentIntent(uri) || super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            return openPaymentIntent(uri) || bridge.launchIntent(uri);
        }
    }

    private void checkForUpdate(boolean force) {
        long now = System.currentTimeMillis();
        if (updateCheckRunning || updateDialogVisible || downloadProgress != null) return;
        if (!force && now - lastUpdateCheckAtMs < UPDATE_CHECK_INTERVAL_MS) return;
        updateCheckRunning = true;
        lastUpdateCheckAtMs = now;
        updateExecutor.execute(() -> {
            try {
                ApkUpdate update = fetchLatestUpdate();
                if (update.versionCode > BuildConfig.VERSION_CODE) {
                    latestUpdate = update;
                    mainHandler.post(() -> {
                        showUpdateNotification(update);
                        showUpdateDialog(update);
                    });
                }
            } catch (Exception ignored) {
                // Update checks must never block normal app startup.
            } finally {
                updateCheckRunning = false;
            }
        });
    }

    private ApkUpdate fetchLatestUpdate() throws Exception {
        URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/download/apk/latest");
        HttpURLConnection connection = openSecureConnection(url);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("Update check failed: " + status);
        }

        String payload = readResponseBody(connection);
        JSONObject json = new JSONObject(payload);
        ApkUpdate update = new ApkUpdate();
        update.id = json.optString("id", "");
        update.versionCode = json.optInt("version_code", 0);
        update.versionName = json.optString("version_name", json.optString("version", ""));
        update.changelog = json.optString("changelog", "");
        update.forceUpdate = json.optBoolean("force_update", false);
        update.sha256 = json.optString("sha256", "");
        update.downloadUrl = resolveDownloadUrl(json.optString("apk_url", json.optString("download_url", "")));
        if (update.downloadUrl.isEmpty()) {
            throw new IllegalStateException("Missing APK URL");
        }
        return update;
    }

    private void showUpdateDialog(ApkUpdate update) {
        if (isFinishing() || updateDialogVisible) return;

        updateDialogVisible = true;
        String title = "System Version Update";
        String message = "Version " + update.versionName + " is available. Download the update to continue with the latest Auto-AI app.";
        if (!update.changelog.trim().isEmpty()) {
            message += "\n\n" + update.changelog.trim();
        }

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton("Update Now", (item, which) -> downloadAndInstall(update))
            .setOnDismissListener(item -> updateDialogVisible = false)
            .create();
        dialog.setCancelable(!update.forceUpdate);
        if (!update.forceUpdate) {
            dialog.setButton(AlertDialog.BUTTON_NEGATIVE, "Later", (item, which) -> item.dismiss());
        }
        dialog.show();
    }

    private void createUpdateNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            UPDATE_NOTIFICATION_CHANNEL_ID,
            "Auto-AI updates",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Auto-AI APK update alerts");
        manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST_CODE);
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void showUpdateNotification(ApkUpdate update) {
        if (!canPostNotifications()) return;
        int lastNotifiedVersion = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE).getInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, 0);
        if (lastNotifiedVersion >= update.versionCode) return;

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);

        String body = "Version " + update.versionName + " is ready to install.";
        if (!update.changelog.trim().isEmpty()) {
            body += " " + update.changelog.trim();
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, UPDATE_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Auto-AI update available")
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
        getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
            .edit()
            .putInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, update.versionCode)
            .apply();
    }

    private void downloadAndInstall(ApkUpdate update) {
        showDownloadProgress(update);
        updateExecutor.execute(() -> {
            Exception lastError = null;
            boolean counted = recordDownloadCount(update);
            String downloadUrl = counted ? countedDownloadUrl(update.downloadUrl) : update.downloadUrl;
            for (int attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
                try {
                    File apkFile = downloadApk(update, downloadUrl);
                    pendingInstallFile = apkFile;
                    mainHandler.post(() -> {
                        dismissDownloadProgress();
                        installOrRequestPermission(apkFile);
                    });
                    return;
                } catch (Exception error) {
                    lastError = error;
                    try {
                        Thread.sleep(800L * attempt);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            Exception finalError = lastError;
            mainHandler.post(() -> {
                dismissDownloadProgress();
                showDownloadFailure(update, finalError);
            });
        });
    }

    private boolean recordDownloadCount(ApkUpdate update) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/download/apk/count");
            connection = openSecureConnection(url);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            String body = update.id.isEmpty()
                ? "{\"version_code\":" + update.versionCode + "}"
                : "{\"id\":\"" + escapeJson(update.id) + "\"}";
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private File downloadApk(ApkUpdate update, String downloadUrl) throws Exception {
        URL url = new URL(downloadUrl);
        HttpURLConnection connection = openSecureConnection(url);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IllegalStateException("APK download failed: " + status);
        }

        File outputFile = new File(getCacheDir(), "auto-ai-update-" + update.versionCode + ".apk");
        if (outputFile.exists() && !outputFile.delete()) {
            throw new IllegalStateException("Unable to replace cached APK");
        }

        long totalBytes = connection.getContentLengthLong();
        long startTimeMs = System.currentTimeMillis();
        long downloadedBytes = 0L;
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(outputFile)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                downloadedBytes += read;
                updateDownloadProgress(downloadedBytes, totalBytes, startTimeMs, "Downloading update...");
            }
        }

        updateDownloadProgress(downloadedBytes, totalBytes, startTimeMs, "Verifying update...");
        if (!update.sha256.isEmpty() && !sha256(outputFile).equalsIgnoreCase(update.sha256)) {
            outputFile.delete();
            throw new IllegalStateException("APK checksum mismatch");
        }
        return outputFile;
    }

    private void showDownloadProgress(ApkUpdate update) {
        mainHandler.post(() -> {
            if (isFinishing()) return;
            dismissDownloadProgress();
            LinearLayout layout = new LinearLayout(this);
            layout.setOrientation(LinearLayout.VERTICAL);
            int padding = dp(22);
            layout.setPadding(padding, padding / 2, padding, 0);

            TextView status = new TextView(this);
            status.setText("Downloading update...");
            status.setTextAlignment(TextView.TEXT_ALIGNMENT_CENTER);
            status.setTextSize(18);
            layout.addView(status);

            ProgressBar progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            progressBar.setMax(100);
            LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            progressParams.setMargins(0, dp(18), 0, dp(10));
            layout.addView(progressBar, progressParams);

            TextView percent = new TextView(this);
            percent.setText("0%");
            percent.setTextAlignment(TextView.TEXT_ALIGNMENT_CENTER);
            percent.setTextSize(20);
            percent.setTypeface(null, android.graphics.Typeface.BOLD);
            layout.addView(percent);

            TextView details = new TextView(this);
            details.setText("Preparing download...");
            details.setTextAlignment(TextView.TEXT_ALIGNMENT_CENTER);
            details.setTextSize(14);
            LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            detailParams.setMargins(0, dp(8), 0, 0);
            layout.addView(details, detailParams);

            AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("System Version Update")
                .setView(layout)
                .setPositiveButton("Downloading...", null)
                .create();
            dialog.setCancelable(false);
            dialog.setOnShowListener(item -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false));
            dialog.show();
            downloadProgress = new DownloadProgress(dialog, progressBar, status, percent, details);
            updateDownloadProgress(0L, 0L, System.currentTimeMillis(), "Downloading update...");
        });
    }

    private void updateDownloadProgress(long downloadedBytes, long totalBytes, long startTimeMs, String status) {
        mainHandler.post(() -> {
            if (downloadProgress == null) return;
            downloadProgress.status.setText(status);
            long elapsedMs = Math.max(1L, System.currentTimeMillis() - startTimeMs);
            double speedBytesPerSecond = downloadedBytes * 1000.0 / elapsedMs;
            if (totalBytes > 0L) {
                int percentValue = (int) Math.min(100L, Math.max(0L, downloadedBytes * 100L / totalBytes));
                downloadProgress.progressBar.setIndeterminate(false);
                downloadProgress.progressBar.setProgress(percentValue);
                downloadProgress.percent.setText(percentValue + "%");
                long remainingBytes = Math.max(0L, totalBytes - downloadedBytes);
                downloadProgress.details.setText(
                    "Speed: " + formatSpeed(speedBytesPerSecond) + "\n"
                        + "Remaining: " + formatSize(remainingBytes) + "\n"
                        + formatSize(downloadedBytes) + " / " + formatSize(totalBytes)
                );
            } else {
                downloadProgress.progressBar.setIndeterminate(true);
                downloadProgress.percent.setText("--%");
                downloadProgress.details.setText("Speed: " + formatSpeed(speedBytesPerSecond) + "\n" + formatSize(downloadedBytes));
            }
        });
    }

    private void dismissDownloadProgress() {
        if (downloadProgress != null) {
            downloadProgress.dialog.dismiss();
            downloadProgress = null;
        }
    }

    private void installOrRequestPermission(File apkFile) {
        if (canRequestPackageInstalls()) {
            openPackageInstaller(apkFile);
            return;
        }
        waitingForInstallPermission = true;
        Toast.makeText(this, "Allow Auto-AI to install updates.", Toast.LENGTH_LONG).show();
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
        intent.setData(Uri.parse("package:" + getPackageName()));
        startActivity(intent);
    }

    private boolean canRequestPackageInstalls() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls();
    }

    private void openPackageInstaller(File apkFile) {
        Uri apkUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            showDownloadFailure(latestUpdate, error);
        }
    }

    private void showDownloadFailure(ApkUpdate update, Exception error) {
        if (update == null) {
            Toast.makeText(this, "Unable to open APK installer.", Toast.LENGTH_LONG).show();
            return;
        }
        String message = "Update download failed.";
        if (error != null && error.getMessage() != null) {
            message += "\n\n" + error.getMessage();
        }
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle("Update failed")
            .setMessage(message)
            .setPositiveButton("Retry", (item, which) -> downloadAndInstall(update))
            .create();
        dialog.setCancelable(!update.forceUpdate);
        if (!update.forceUpdate) {
            dialog.setButton(AlertDialog.BUTTON_NEGATIVE, "Cancel", (item, which) -> item.dismiss());
        }
        dialog.show();
    }

    private HttpURLConnection openSecureConnection(URL url) throws Exception {
        if (!isAllowedDownloadScheme(url)) {
            throw new SecurityException("APK updates require HTTPS.");
        }
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        return connection;
    }

    private String readResponseBody(HttpURLConnection connection) throws Exception {
        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString("UTF-8");
        }
    }

    private boolean isAllowedDownloadScheme(URL url) {
        String protocol = url.getProtocol().toLowerCase(Locale.US);
        String host = url.getHost().toLowerCase(Locale.US);
        return "https".equals(protocol) || ("http".equals(protocol) && ("localhost".equals(host) || "127.0.0.1".equals(host)));
    }

    private String resolveDownloadUrl(String value) throws Exception {
        URI baseUri = URI.create(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL));
        return baseUri.resolve(value).toString();
    }

    private String countedDownloadUrl(String value) {
        if (!isInternalApkDownloadUrl(value) || value.contains("counted=")) {
            return value;
        }
        return value + (value.contains("?") ? "&" : "?") + "counted=true";
    }

    private boolean isInternalApkDownloadUrl(String value) {
        try {
            URI apiBase = URI.create(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL));
            URI uri = URI.create(value);
            String host = uri.getHost();
            String baseHost = apiBase.getHost();
            String path = uri.getPath();
            return host != null
                && baseHost != null
                && host.equalsIgnoreCase(baseHost)
                && path != null
                && path.endsWith("/api/download/apk");
        } catch (Exception ignored) {
            return false;
        }
    }

    private String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String formatSpeed(double bytesPerSecond) {
        return String.format(Locale.US, "%.2f KB/s", bytesPerSecond / 1024.0);
    }

    private String formatSize(long bytes) {
        return String.format(Locale.US, "%.2f MB", bytes / 1024.0 / 1024.0);
    }

    private String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) {
            result.append(String.format(Locale.US, "%02x", value));
        }
        return result.toString();
    }

    private static class ApkUpdate {
        String id = "";
        int versionCode;
        String versionName = "";
        String downloadUrl = "";
        String changelog = "";
        String sha256 = "";
        boolean forceUpdate;
    }

    private static class DownloadProgress {
        final AlertDialog dialog;
        final ProgressBar progressBar;
        final TextView status;
        final TextView percent;
        final TextView details;

        DownloadProgress(AlertDialog dialog, ProgressBar progressBar, TextView status, TextView percent, TextView details) {
            this.dialog = dialog;
            this.progressBar = progressBar;
            this.status = status;
            this.percent = percent;
            this.details = details;
        }
    }
}
