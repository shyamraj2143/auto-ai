package com.autoai.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Application-scoped single source of truth for APK update checks and handoff. */
public final class AppUpdateCoordinator {
    public enum State { CHECKING, AVAILABLE, QUEUED, DOWNLOADING, PAUSED_WAITING_FOR_NETWORK, VERIFYING,
        READY_TO_INSTALL, INSTALL_PERMISSION_REQUIRED, OPENING_INSTALLER, INSTALLED, UP_TO_DATE, FAILED, IDLE }
    public interface Listener { void onUpdateChanged(Snapshot snapshot); }

    public static final String PREFS = "auto_ai_update_preferences";
    private static final String WORK_NAME = "auto_ai_apk_download";
    private static final long CHECK_COOLDOWN_MS = 5L * 60L * 1000L;
    private static final String GITHUB_RELEASE_API =
        "https://api.github.com/repos/shyamraj2143/auto-ai/releases/latest";
    private static final String GITHUB_RELEASE_DOWNLOAD_PREFIX =
        "/shyamraj2143/auto-ai/releases/download/";
    private static volatile AppUpdateCoordinator instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean checking = new AtomicBoolean(false);
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile Snapshot snapshot;
    private volatile boolean optionalDismissedThisLaunch;
    private volatile boolean downloadAfterCheck;
    private final AtomicBoolean directStart = new AtomicBoolean(false);

    public static AppUpdateCoordinator get(Context context) {
        if (instance == null) synchronized (AppUpdateCoordinator.class) {
            if (instance == null) instance = new AppUpdateCoordinator(context.getApplicationContext());
        }
        return instance;
    }

    private AppUpdateCoordinator(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        snapshot = Snapshot.restore(prefs);
        observeDownload();
        clearCompletedUpdate();
        if (hasPendingUpdate(snapshot.metadata)) {
            // Every published AutoAI Android version is required. Re-apply the policy
            // when restoring state so an update discovered by an older build cannot
            // become dismissible after the process is recreated mid-download.
            snapshot.metadata.mandatory = true;
            snapshot.metadata.forceUpdate = true;
            if (snapshot.state == State.IDLE) {
                snapshot = new Snapshot(State.AVAILABLE, snapshot.metadata, 0, snapshot.metadata.fileSize, "Ready to download", "");
            }
        }
    }

    public Snapshot current() { return snapshot; }
    public void addListener(Listener listener) { listeners.addIfAbsent(listener); listener.onUpdateChanged(snapshot); }
    public void removeListener(Listener listener) { listeners.remove(listener); }

    public void check(boolean userInitiated) {
        long now = System.currentTimeMillis();
        if (!userInitiated && now - prefs.getLong("last_successful_check", 0L) < CHECK_COOLDOWN_MS) return;
        if (!checking.compareAndSet(false, true)) return;
        set(snapshot.withState(State.CHECKING, "Checking for a secure update..."));
        executor.execute(() -> {
            try {
                Metadata metadata = fetch();
                prefs.edit().putLong("last_successful_check", System.currentTimeMillis()).apply();
                if (!metadata.valid() || metadata.versionCode <= BuildConfig.VERSION_CODE) {
                    downloadAfterCheck = false;
                    directStart.set(false);
                    prefs.edit().putBoolean("direct_update_active", false).apply();
                    set(new Snapshot(State.UP_TO_DATE, metadata, 0, 0, "AutoAI is up to date.", ""));
                    return;
                }
                boolean mandatory = requiresMandatoryUpdate(BuildConfig.VERSION_CODE, metadata.versionCode);
                if (!mandatory && optionalDismissedThisLaunch) {
                    set(new Snapshot(State.IDLE, metadata, 0, metadata.fileSize, "", ""));
                    return;
                }
                metadata.forceUpdate = mandatory;
                metadata.mandatory = mandatory;
                if (hasVerifiedApk(metadata)) {
                    downloadAfterCheck = false;
                    set(new Snapshot(State.READY_TO_INSTALL, metadata, metadata.fileSize, metadata.fileSize, "Secure update verified", ""));
                    return;
                }
                set(new Snapshot(State.AVAILABLE, metadata, 0, metadata.fileSize, "Ready to download", ""));
                if (downloadAfterCheck) {
                    downloadAfterCheck = false;
                    download();
                }
            } catch (Exception error) {
                downloadAfterCheck = false;
                if (optionalDismissedThisLaunch && hasPendingUpdate(snapshot.metadata)) {
                    set(new Snapshot(State.IDLE, snapshot.metadata, snapshot.downloadedBytes, snapshot.totalBytes, friendly(error), ""));
                } else set(snapshot.withFailure(friendly(error)));
            } finally { checking.set(false); }
        });
    }

    /** Starts one durable download, fetching authoritative metadata first when needed. */
    public synchronized void downloadOrCheck() {
        if (hasVerifiedApk()) {
            set(snapshot.withState(State.READY_TO_INSTALL, "Secure update verified"));
            return;
        }
        if (hasPendingUpdate(snapshot.metadata)) {
            downloadAfterCheck = false;
            download();
            return;
        }
        downloadAfterCheck = true;
        check(true);
    }

    /** One-tap path used by the header and update-notification action. */
    public synchronized void startDirectUpdate() {
        if (!directStart.compareAndSet(false, true)
            && (snapshot.state == State.CHECKING || snapshot.state == State.QUEUED
                || snapshot.state == State.DOWNLOADING || snapshot.state == State.VERIFYING
                || snapshot.state == State.OPENING_INSTALLER)) return;
        prefs.edit().putBoolean("direct_update_active", true).apply();
        if (snapshot.state == State.INSTALL_PERMISSION_REQUIRED || hasVerifiedApk()) {
            set(snapshot.withState(State.READY_TO_INSTALL, "Secure update verified"));
            return;
        }
        if (hasPendingUpdate(snapshot.metadata)) {
            downloadAfterCheck = false;
            download();
            return;
        }
        downloadAfterCheck = true;
        check(true);
    }

    public boolean isDirectUpdateActive() {
        return directStart.get() || prefs.getBoolean("direct_update_active", false);
    }

    private boolean hasVerifiedApk() {
        return hasVerifiedApk(snapshot.metadata);
    }

    private boolean hasVerifiedApk(@Nullable Metadata metadata) {
        String path = prefs.getString("downloaded_apk_path", "");
        java.io.File file = path.isEmpty() ? null : new java.io.File(path);
        int activeDownloadVersion = prefs.getInt("active_download_version", 0);
        return hasPendingUpdate(metadata)
            && downloadedVersionMatches(activeDownloadVersion, metadata.versionCode)
            && file != null && file.isFile() && file.length() > 0;
    }

    public void dismissOptional() {
        Metadata m = snapshot.metadata;
        if (m == null || m.mandatory) return;
        optionalDismissedThisLaunch = true;
        set(new Snapshot(State.IDLE, m, 0, m.fileSize, "", ""));
    }

    /** Reopens the one native update surface without starting another API check or download. */
    public void showAvailable() {
        Metadata m = snapshot.metadata;
        if (!hasPendingUpdate(m)) return;
        optionalDismissedThisLaunch = false;
        if (snapshot.state == State.IDLE || snapshot.state == State.FAILED) {
            set(new Snapshot(State.AVAILABLE, m, snapshot.downloadedBytes, snapshot.totalBytes, "Ready to download", ""));
        }
    }

    public static boolean hasPendingUpdate(@Nullable Metadata metadata) {
        return metadata != null && metadata.valid()
            && requiresMandatoryUpdate(BuildConfig.VERSION_CODE, metadata.versionCode);
    }

    /** AutoAI publishes a new APK for every production main push, so every higher version is mandatory. */
    static boolean requiresMandatoryUpdate(int installedVersionCode, int latestVersionCode) {
        return latestVersionCode > installedVersionCode;
    }

    static boolean downloadedVersionMatches(int activeDownloadVersion, int latestVersionCode) {
        return activeDownloadVersion > 0 && activeDownloadVersion == latestVersionCode;
    }

    public void download() {
        Metadata m = snapshot.metadata;
        if (m == null || !m.valid() || m.versionCode <= BuildConfig.VERSION_CODE) return;
        if (snapshot.state == State.QUEUED || snapshot.state == State.DOWNLOADING || snapshot.state == State.VERIFYING) return;
        int previousDownloadVersion = prefs.getInt("active_download_version", 0);
        boolean replacePreviousVersion = previousDownloadVersion > 0 && previousDownloadVersion != m.versionCode;
        if (replacePreviousVersion) {
            String previousPath = prefs.getString("downloaded_apk_path", "");
            if (!previousPath.isEmpty()) new java.io.File(previousPath).delete();
            prefs.edit().remove("downloaded_apk_path").remove("installer_pending").apply();
        }
        Data input = new Data.Builder().putString("metadata", m.toJson().toString()).build();
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AppUpdateDownloadWorker.class)
            .setInputData(input).setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build();
        prefs.edit().putInt("active_download_version", m.versionCode).putString("download_work_id", request.getId().toString()).apply();
        set(new Snapshot(State.QUEUED, m, 0, m.fileSize, "Waiting to download", ""));
        WorkManager.getInstance(context).enqueueUniqueWork(
            WORK_NAME,
            replacePreviousVersion ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP,
            request
        );
    }

    public void cancelOptional() {
        if (snapshot.metadata != null && !snapshot.metadata.mandatory) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
            prefs.edit().remove("active_download_version").remove("download_work_id").apply();
            set(new Snapshot(State.AVAILABLE, snapshot.metadata, 0, snapshot.metadata.fileSize, "Download cancelled", ""));
        }
    }

    public boolean canInstallPackages() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.getPackageManager().canRequestPackageInstalls();
    }

    public Intent installPermissionIntent() {
        return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
    }

    public Intent installerIntent() {
        if (!hasVerifiedApk()) return null;
        String path = prefs.getString("downloaded_apk_path", "");
        if (path.isEmpty()) return null;
        java.io.File file = new java.io.File(path);
        if (!file.isFile() || file.length() == 0) return null;
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        prefs.edit().putBoolean("installer_pending", true).apply();
        set(snapshot.withState(State.OPENING_INSTALLER, "Opening Android installer..."));
        return new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    public void refreshInstallState() {
        if (snapshot.state == State.INSTALL_PERMISSION_REQUIRED && canInstallPackages()) {
            set(snapshot.withState(State.READY_TO_INSTALL, "Secure update verified"));
        } else if (snapshot.state == State.OPENING_INSTALLER && snapshot.metadata != null && BuildConfig.VERSION_CODE < snapshot.metadata.versionCode) {
            directStart.set(false);
            set(snapshot.withFailure("Installation cancelled"));
        }
    }

    public void requireInstallPermission() { set(snapshot.withState(State.INSTALL_PERMISSION_REQUIRED, "Allow AutoAI to install this verified update.")); }

    private Metadata fetch() throws Exception {
        Exception backendError;
        try {
            return fetchBackend();
        } catch (Exception error) {
            backendError = error;
        }

        try {
            return fetchGitHub();
        } catch (Exception githubError) {
            githubError.addSuppressed(backendError);
            throw githubError;
        }
    }

    private Metadata fetchBackend() throws Exception {
        URL url = new URL(apiUrl("download/apk/latest"));
        JSONObject json = fetchJson(url, "application/json");
        Metadata m = Metadata.from(json);
        m.downloadUrl = resolveTrustedUrl(json.optString("download_url", json.optString("apk_url", "")));
        return m;
    }

    private Metadata fetchGitHub() throws Exception {
        JSONObject json = fetchJson(new URL(GITHUB_RELEASE_API), "application/vnd.github+json");
        return parseGitHubRelease(json);
    }

    private JSONObject fetchJson(URL url, String accept) throws Exception {
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Accept", accept);
        c.setRequestProperty("User-Agent", "AutoAI-Android-Updater/" + BuildConfig.VERSION_NAME);
        if (c.getResponseCode() < 200 || c.getResponseCode() >= 300) throw new IllegalStateException("server:" + c.getResponseCode());
        return new JSONObject(read(c));
    }

    static Metadata parseGitHubRelease(JSONObject json) throws Exception {
        JSONArray assets = json.optJSONArray("assets");
        JSONObject apk = null;
        if (assets != null) {
            for (int index = 0; index < assets.length(); index++) {
                JSONObject candidate = assets.optJSONObject(index);
                if (candidate != null && "auto-ai.apk".equalsIgnoreCase(candidate.optString("name", ""))) {
                    apk = candidate;
                    break;
                }
            }
        }
        if (apk == null) throw new IllegalStateException("GitHub release has no AutoAI APK.");

        String body = json.optString("body", "");
        Metadata m = new Metadata();
        m.versionCode = requiredInt(body, "Version-Code:\\s*(\\d+)");
        m.versionName = requiredText(body, "Version-Name:\\s*([^\\s]+)");
        m.sha256 = requiredText(body, "SHA256:\\s*([A-Fa-f0-9]{64})").toLowerCase(Locale.US);
        m.downloadUrl = apk.optString("browser_download_url", "");
        if (!isTrustedDownloadUrl(m.downloadUrl)) throw new SecurityException("Untrusted GitHub APK URL.");
        m.id = "github-" + m.versionCode;
        m.fileSize = apk.optLong("size", 0L);
        m.packageName = "com.autoai.app";
        m.minimumAndroidSdk = 24;
        m.minimumSupportedVersionCode = 1;
        m.forceUpdate = true;
        m.mandatory = true;
        m.changelog = optionalText(body, "Changelog:\\s*([^\\r\\n]+)", "AutoAI update");
        m.releaseDate = json.optString("published_at", json.optString("created_at", ""));
        return m;
    }

    private static int requiredInt(String value, String pattern) {
        String text = requiredText(value, pattern);
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException error) {
            throw new IllegalStateException("Invalid GitHub release version.");
        }
    }

    private static String requiredText(String value, String pattern) {
        Matcher matcher = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE).matcher(value == null ? "" : value);
        if (!matcher.find()) throw new IllegalStateException("Incomplete GitHub release metadata.");
        return matcher.group(1).trim();
    }

    private static String optionalText(String value, String pattern, String fallback) {
        Matcher matcher = Pattern.compile(pattern, Pattern.CASE_INSENSITIVE).matcher(value == null ? "" : value);
        return matcher.find() ? matcher.group(1).trim() : fallback;
    }

    public static String apiUrl(String relative) {
        String base = BuildConfig.AUTO_AI_API_BASE_URL == null ? "" : BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "");
        String suffix = relative == null ? "" : relative.replaceAll("^/+", "");
        return base + "/" + suffix;
    }

    private String resolveTrustedUrl(String value) throws Exception {
        URI base = URI.create(apiUrl(""));
        URI candidate = URI.create(value);
        URI resolved = candidate.isAbsolute() ? candidate : base.resolve(value.startsWith("/") ? value : "./" + value);
        if (!isTrustedDownloadUrl(resolved.toString()))
            throw new SecurityException("Untrusted APK download URL.");
        return resolved.toString();
    }

    static boolean isTrustedDownloadUrl(String value) {
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return false;
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
            URI api = URI.create(apiUrl(""));
            if (host.equalsIgnoreCase(api.getHost())) {
                String path = uri.getPath() == null ? "" : uri.getPath();
                return path.startsWith("/api/download/apk") || path.startsWith("/api/v1/download/apk");
            }
            String path = uri.getPath() == null ? "" : uri.getPath();
            return "github.com".equals(host)
                && path.startsWith(GITHUB_RELEASE_DOWNLOAD_PREFIX)
                && path.endsWith("/auto-ai.apk");
        } catch (RuntimeException error) {
            return false;
        }
    }

    static boolean isTrustedResolvedDownloadUrl(String value) {
        if (isTrustedDownloadUrl(value)) return true;
        try {
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null) return false;
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
            return "release-assets.githubusercontent.com".equals(host)
                || "objects.githubusercontent.com".equals(host);
        } catch (RuntimeException error) {
            return false;
        }
    }

    private void observeDownload() {
        WorkManager.getInstance(context).getWorkInfosForUniqueWorkLiveData(WORK_NAME).observeForever(infos -> {
            if (infos == null || infos.isEmpty()) return;
            WorkInfo info = infos.get(0); Data p = info.getProgress();
            String stateName = p.getString("state");
            State state = stateName == null ? map(info.getState()) : State.valueOf(stateName);
            long done = p.getLong("downloaded", snapshot.downloadedBytes);
            long total = p.getLong("total", snapshot.totalBytes);
            String message = p.getString("message"); String error = info.getOutputData().getString("error");
            if (info.getState() == WorkInfo.State.SUCCEEDED) {
                String path = info.getOutputData().getString("path");
                prefs.edit().putString("downloaded_apk_path", path == null ? "" : path).putBoolean("installer_pending", true).apply();
                state = State.READY_TO_INSTALL; message = "Secure update verified";
            } else if (info.getState() == WorkInfo.State.FAILED) { state = State.FAILED; message = error; }
            set(new Snapshot(state, snapshot.metadata, done, total, message == null ? "" : message, error == null ? "" : error));
        });
    }

    private State map(WorkInfo.State state) {
        if (state == WorkInfo.State.ENQUEUED || state == WorkInfo.State.BLOCKED) return State.PAUSED_WAITING_FOR_NETWORK;
        if (state == WorkInfo.State.RUNNING) return State.DOWNLOADING;
        return snapshot.state;
    }

    private void clearCompletedUpdate() {
        int active = prefs.getInt("active_download_version", 0);
        if (active > 0 && BuildConfig.VERSION_CODE >= active) {
            String path = prefs.getString("downloaded_apk_path", "");
            if (!path.isEmpty()) new java.io.File(path).delete();
            prefs.edit().remove("active_download_version").remove("download_work_id").remove("downloaded_apk_path").remove("installer_pending").apply();
            snapshot = new Snapshot(State.INSTALLED, null, 0, 0, "Update installed", "");
        }
    }

    private synchronized void set(Snapshot value) { snapshot = value; value.persist(prefs); for (Listener l : listeners) l.onUpdateChanged(value); }
    private static String read(HttpURLConnection c) throws Exception { try (BufferedInputStream in = new BufferedInputStream(c.getInputStream()); ByteArrayOutputStream out = new ByteArrayOutputStream()) { byte[] b=new byte[4096]; int n; while((n=in.read(b))!=-1) out.write(b,0,n); return out.toString("UTF-8"); } }
    private static String friendly(Exception e) { String m=e.getMessage()==null?"":e.getMessage(); if (m.contains("server:")) return "Update server is temporarily unavailable."; if (e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException) return "No internet connection. Please try again."; return m.isEmpty()?"Update check failed. Please try again.":m; }

    public static final class Metadata {
        public String id="", versionName="", downloadUrl="", sha256="", packageName="", changelog="", releaseDate="";
        public int versionCode, minimumSupportedVersionCode, minimumAndroidSdk=24; public long fileSize; public boolean forceUpdate, mandatory;
        static Metadata from(JSONObject j) { Metadata m=new Metadata(); m.id=j.optString("release_id",j.optString("id","")); m.versionCode=j.optInt("latest_version_code",j.optInt("version_code",0)); m.versionName=j.optString("latest_version",j.optString("version_name",j.optString("version",""))); m.fileSize=j.optLong("file_size",0); m.sha256=j.optString("sha256",""); m.packageName=j.optString("package_name",""); m.minimumSupportedVersionCode=j.optInt("minimum_supported_version_code",0); m.minimumAndroidSdk=j.optInt("minimum_android_sdk",24); m.forceUpdate=j.optBoolean("force_update",false); m.changelog=j.optString("changelog",""); m.releaseDate=j.optString("release_date",j.optString("released_at","")); return m; }
        boolean valid() { return versionCode>0 && !versionName.trim().isEmpty() && downloadUrl!=null && !downloadUrl.isEmpty() && sha256.matches("(?i)[0-9a-f]{64}") && "com.autoai.app".equals(packageName) && minimumAndroidSdk<=Build.VERSION.SDK_INT; }
        JSONObject toJson() { JSONObject j=new JSONObject(); try { j.put("id",id);j.put("version_code",versionCode);j.put("version_name",versionName);j.put("download_url",downloadUrl);j.put("file_size",fileSize);j.put("sha256",sha256);j.put("package_name",packageName);j.put("minimum_supported_version_code",minimumSupportedVersionCode);j.put("minimum_android_sdk",minimumAndroidSdk);j.put("force_update",forceUpdate);j.put("mandatory",mandatory);j.put("changelog",changelog);j.put("release_date",releaseDate); } catch(Exception ignored){} return j; }
        static Metadata restore(JSONObject j) { Metadata m=from(j); m.downloadUrl=j.optString("download_url",""); m.mandatory=j.optBoolean("mandatory",false); return m; }
    }

    public static final class Snapshot {
        public final State state; public final Metadata metadata; public final long downloadedBytes,totalBytes; public final String message,error;
        Snapshot(State s, Metadata m,long d,long t,String msg,String e){state=s;metadata=m;downloadedBytes=d;totalBytes=t;message=msg;error=e;}
        Snapshot withState(State s,String msg){return new Snapshot(s,metadata,downloadedBytes,totalBytes,msg,"");}
        Snapshot withFailure(String msg){return new Snapshot(State.FAILED,metadata,downloadedBytes,totalBytes,msg,msg);}
        void persist(SharedPreferences p){p.edit().putString("state",state.name()).putString("metadata",metadata==null?"":metadata.toJson().toString()).putLong("downloaded",downloadedBytes).putLong("total",totalBytes).putString("message",message).putString("error",error).apply();}
        static Snapshot restore(SharedPreferences p){try{String raw=p.getString("metadata",""); Metadata m=raw.isEmpty()?null:Metadata.restore(new JSONObject(raw)); return new Snapshot(State.valueOf(p.getString("state","IDLE")),m,p.getLong("downloaded",0),p.getLong("total",0),p.getString("message",""),p.getString("error",""));}catch(Exception e){return new Snapshot(State.IDLE,null,0,0,"","");}}
    }
}
