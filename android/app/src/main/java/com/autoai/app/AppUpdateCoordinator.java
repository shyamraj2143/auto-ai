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

/** Application-scoped single source of truth for APK update checks and handoff. */
public final class AppUpdateCoordinator {
    public enum State { CHECKING, AVAILABLE, QUEUED, DOWNLOADING, PAUSED_WAITING_FOR_NETWORK, VERIFYING,
        READY_TO_INSTALL, INSTALL_PERMISSION_REQUIRED, OPENING_INSTALLER, INSTALLED, FAILED, IDLE }
    public interface Listener { void onUpdateChanged(Snapshot snapshot); }

    public static final String PREFS = "auto_ai_update_preferences";
    private static final String WORK_NAME = "auto_ai_apk_download";
    private static final long CHECK_COOLDOWN_MS = 5L * 60L * 1000L;
    private static volatile AppUpdateCoordinator instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean checking = new AtomicBoolean(false);
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile Snapshot snapshot;
    private volatile boolean optionalDismissedThisLaunch;
    private volatile boolean downloadAfterCheck;

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
        if (hasPendingUpdate(snapshot.metadata) && snapshot.state == State.IDLE) {
            snapshot = new Snapshot(State.AVAILABLE, snapshot.metadata, 0, snapshot.metadata.fileSize, "Ready to download", "");
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
                    set(new Snapshot(State.IDLE, metadata, 0, 0, userInitiated ? "AutoAI is up to date." : "", ""));
                    return;
                }
                boolean mandatory = metadata.forceUpdate || BuildConfig.VERSION_CODE < metadata.minimumSupportedVersionCode;
                if (!mandatory && optionalDismissedThisLaunch) {
                    set(new Snapshot(State.IDLE, metadata, 0, metadata.fileSize, "", ""));
                    return;
                }
                metadata.mandatory = mandatory;
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

    private boolean hasVerifiedApk() {
        String path = prefs.getString("downloaded_apk_path", "");
        java.io.File file = path.isEmpty() ? null : new java.io.File(path);
        return hasPendingUpdate(snapshot.metadata) && file != null && file.isFile() && file.length() > 0;
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
        return metadata != null && metadata.valid() && metadata.versionCode > BuildConfig.VERSION_CODE;
    }

    public void download() {
        Metadata m = snapshot.metadata;
        if (m == null || !m.valid() || m.versionCode <= BuildConfig.VERSION_CODE) return;
        if (snapshot.state == State.QUEUED || snapshot.state == State.DOWNLOADING || snapshot.state == State.VERIFYING) return;
        Data input = new Data.Builder().putString("metadata", m.toJson().toString()).build();
        Constraints constraints = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(AppUpdateDownloadWorker.class)
            .setInputData(input).setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build();
        prefs.edit().putInt("active_download_version", m.versionCode).putString("download_work_id", request.getId().toString()).apply();
        set(new Snapshot(State.QUEUED, m, 0, m.fileSize, "Waiting to download", ""));
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request);
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
            set(snapshot.withState(State.READY_TO_INSTALL, "Installation cancelled. Tap Retry Install."));
        }
    }

    public void requireInstallPermission() { set(snapshot.withState(State.INSTALL_PERMISSION_REQUIRED, "Allow AutoAI to install this verified update.")); }

    private Metadata fetch() throws Exception {
        URL url = new URL(apiUrl("download/apk/latest"));
        HttpURLConnection c = (HttpURLConnection) url.openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setRequestProperty("Accept", "application/json");
        if (c.getResponseCode() < 200 || c.getResponseCode() >= 300) throw new IllegalStateException("server:" + c.getResponseCode());
        JSONObject json = new JSONObject(read(c));
        Metadata m = Metadata.from(json);
        m.downloadUrl = resolveTrustedUrl(json.optString("download_url", json.optString("apk_url", "")));
        return m;
    }

    public static String apiUrl(String relative) {
        String base = BuildConfig.AUTO_AI_API_BASE_URL == null ? "" : BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "");
        String suffix = relative == null ? "" : relative.replaceAll("^/+", "");
        return base + "/" + suffix;
    }

    private String resolveTrustedUrl(String value) throws Exception {
        URI base = URI.create(apiUrl(""));
        URI resolved = base.resolve(value.startsWith("/") ? value : "./" + value);
        if (!"https".equalsIgnoreCase(resolved.getScheme()) || !base.getHost().equalsIgnoreCase(resolved.getHost()))
            throw new SecurityException("Untrusted APK download URL.");
        return resolved.toString();
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
