package com.autoai.app;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 60000;
    private static final int MAX_DOWNLOAD_ATTEMPTS = 3;

    private final ExecutorService updateExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private ApkUpdate latestUpdate;
    private File pendingInstallFile;
    private boolean updateDialogVisible;
    private boolean waitingForInstallPermission;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        webView.setNestedScrollingEnabled(true);
        webView.setVerticalScrollBarEnabled(false);
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
        webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);

        WebSettings settings = webView.getSettings();
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        checkForUpdate();
    }

    @Override
    public void onResume() {
        super.onResume();
        if (waitingForInstallPermission && pendingInstallFile != null && canRequestPackageInstalls()) {
            waitingForInstallPermission = false;
            openPackageInstaller(pendingInstallFile);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        updateExecutor.shutdownNow();
    }

    private void checkForUpdate() {
        updateExecutor.execute(() -> {
            try {
                ApkUpdate update = fetchLatestUpdate();
                if (update.versionCode > BuildConfig.VERSION_CODE) {
                    latestUpdate = update;
                    mainHandler.post(() -> showUpdateDialog(update));
                }
            } catch (Exception ignored) {
                // Update checks must never block normal app startup.
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
        String title = update.forceUpdate ? "Update required" : "Update available";
        String message = "Version " + update.versionName + " is available.";
        if (!update.changelog.trim().isEmpty()) {
            message += "\n\n" + update.changelog.trim();
        }

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton("Update", (item, which) -> downloadAndInstall(update))
            .setOnDismissListener(item -> updateDialogVisible = false)
            .create();
        dialog.setCancelable(!update.forceUpdate);
        if (!update.forceUpdate) {
            dialog.setButton(AlertDialog.BUTTON_NEGATIVE, "Later", (item, which) -> item.dismiss());
        }
        dialog.show();
    }

    private void downloadAndInstall(ApkUpdate update) {
        Toast.makeText(this, "Downloading update...", Toast.LENGTH_SHORT).show();
        updateExecutor.execute(() -> {
            Exception lastError = null;
            for (int attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
                try {
                    File apkFile = downloadApk(update);
                    pendingInstallFile = apkFile;
                    mainHandler.post(() -> installOrRequestPermission(apkFile));
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
            mainHandler.post(() -> showDownloadFailure(update, finalError));
        });
    }

    private File downloadApk(ApkUpdate update) throws Exception {
        URL url = new URL(update.downloadUrl);
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

        try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
             FileOutputStream output = new FileOutputStream(outputFile)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }

        if (!update.sha256.isEmpty() && !sha256(outputFile).equalsIgnoreCase(update.sha256)) {
            outputFile.delete();
            throw new IllegalStateException("APK checksum mismatch");
        }
        return outputFile;
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
        int versionCode;
        String versionName = "";
        String downloadUrl = "";
        String changelog = "";
        String sha256 = "";
        boolean forceUpdate;
    }
}
