package com.autoai.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

public final class AppUpdateDownloadWorker extends Worker {
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private AppUpdateCoordinator.Metadata activeMetadata;
    private int lastNotifiedPercent = -1;

    public AppUpdateDownloadWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }

    @NonNull @Override public Result doWork() {
        File partial = null;
        try {
            AppUpdateCoordinator.Metadata metadata = AppUpdateCoordinator.Metadata.restore(new JSONObject(getInputData().getString("metadata")));
            activeMetadata = metadata;
            if (!metadata.valid() || metadata.versionCode <= BuildConfig.VERSION_CODE) return failure("Invalid or outdated update metadata.");
            if (!AppUpdateCoordinator.isTrustedDownloadUrl(metadata.downloadUrl)) return failure("Untrusted APK download URL.");
            File dir = new File(getApplicationContext().getFilesDir(), "updates");
            if (!dir.exists() && !dir.mkdirs()) return failure("Unable to prepare secure update storage.");
            partial = new File(dir, "autoai-" + metadata.versionCode + ".apk.part");
            File apk = new File(dir, "autoai-" + metadata.versionCode + ".apk");
            if (partial.exists()) partial.delete(); if (apk.exists()) apk.delete();
            progress(AppUpdateCoordinator.State.DOWNLOADING, 0, metadata.fileSize, "Downloading update...");
            HttpURLConnection c=(HttpURLConnection)new URL(metadata.downloadUrl).openConnection(); c.setConnectTimeout(15000);c.setReadTimeout(60000);c.setRequestProperty("Accept","application/vnd.android.package-archive");
            int status=c.getResponseCode(); if(status<200||status>=300) return retryOrFail("Download failed (HTTP " + status + ").");
            if(!AppUpdateCoordinator.isTrustedResolvedDownloadUrl(c.getURL().toString())) return failure("Download redirected to an untrusted server.");
            long total=c.getContentLengthLong(); if(total<=0) total=metadata.fileSize;
            long done=0; try(BufferedInputStream in=new BufferedInputStream(c.getInputStream());FileOutputStream out=new FileOutputStream(partial)){byte[] b=new byte[32768];int n;while((n=in.read(b))!=-1){if(isStopped())return Result.failure();out.write(b,0,n);done+=n;progress(AppUpdateCoordinator.State.DOWNLOADING,done,total,"Downloading update...");}}
            if(done<=0) return failure("Downloaded APK is empty.");
            if(total>0&&done!=total) return retryOrFail("Download was incomplete.");
            if(metadata.fileSize>0&&done!=metadata.fileSize) return failure("APK file size does not match the published build.");
            progress(AppUpdateCoordinator.State.VERIFYING,done,total,"Verifying secure update...");
            if(!sha256(partial).equalsIgnoreCase(metadata.sha256)){partial.delete();return failure("Checksum mismatch. Download the update again.");}
            PackageManager pm=getApplicationContext().getPackageManager(); PackageInfo info=pm.getPackageArchiveInfo(partial.getAbsolutePath(),0);
            if(info==null){partial.delete();return failure("Invalid or corrupted APK.");}
            if(!"com.autoai.app".equals(info.packageName)){partial.delete();return failure("The downloaded APK belongs to a different app.");}
            long version=Build.VERSION.SDK_INT>=28?info.getLongVersionCode():info.versionCode;
            if(version!=metadata.versionCode||version<=BuildConfig.VERSION_CODE){partial.delete();return failure("The downloaded APK version does not match the published update.");}
            if(!signaturesMatch(pm, partial)){partial.delete();return failure("This update cannot be installed because its signing certificate does not match the installed AutoAI app.");}
            if(!partial.renameTo(apk)) return failure("Unable to finalize downloaded update.");
            showNotification("Update ready to install", "AutoAI " + metadata.versionName + " was downloaded and verified.", false, 100);
            return Result.success(new Data.Builder().putString("path",apk.getAbsolutePath()).build());
        } catch(java.net.UnknownHostException|java.net.SocketTimeoutException e){return retryOrFail("Waiting for internet connection.");}
        catch(Exception e){if(partial!=null)partial.delete();return failure(e.getMessage()==null?"Download failed.":e.getMessage());}
    }

    private Result retryOrFail(String message){progress(AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK,0,0,message);return getRunAttemptCount()<4?Result.retry():failure(message);}
    private Result failure(String message){
        if (isBackgrounded()) showNotification("Update paused", message, false, -1);
        return Result.failure(new Data.Builder().putString("error",message).build());
    }
    private void progress(AppUpdateCoordinator.State state,long done,long total,String message){
        setProgressAsync(new Data.Builder().putString("state",state.name()).putLong("downloaded",done).putLong("total",total).putString("message",message).build());
        if (!isBackgrounded()) return;
        int percent = total > 0 ? (int)Math.min(100L, done * 100L / total) : -1;
        if (percent >= 0 && lastNotifiedPercent >= 0 && percent < lastNotifiedPercent + 2 && percent < 100) return;
        lastNotifiedPercent = percent;
        showNotification("Downloading AutoAI update", percent >= 0 ? percent + "% complete" : message, true, percent);
    }

    private boolean isBackgrounded() {
        return activeMetadata != null && getApplicationContext()
            .getSharedPreferences(AppUpdateCoordinator.PREFS, Context.MODE_PRIVATE)
            .getInt("background_download_version", 0) == activeMetadata.versionCode;
    }

    private void showNotification(String title, String body, boolean ongoing, int percent) {
        Context context = getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = (NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        UpdateNotificationChannel.create(context);
        Intent intent = new Intent(context, MainActivity.class)
            .putExtra("start_app_update", true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        int requestCode = 8200 + (activeMetadata == null ? 0 : Math.abs(activeMetadata.versionCode % 100000));
        PendingIntent pendingIntent = PendingIntent.getActivity(context, requestCode, intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(context, UpdateNotificationChannel.ID) : new Notification.Builder(context);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title).setContentText(body).setContentIntent(pendingIntent)
            .setOngoing(ongoing).setAutoCancel(!ongoing).setOnlyAlertOnce(ongoing)
            .setCategory(Notification.CATEGORY_SYSTEM).setVisibility(Notification.VISIBILITY_PRIVATE);
        if (percent >= 0 && ongoing) builder.setProgress(100, percent, false);
        if (!ongoing) builder.addAction(new Notification.Action.Builder(android.R.drawable.stat_sys_download_done, "Open update", pendingIntent).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(ongoing ? Notification.PRIORITY_LOW : Notification.PRIORITY_HIGH);
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
    }
    @SuppressWarnings("deprecation") private boolean signaturesMatch(PackageManager pm,File archive)throws Exception{
        int flags=Build.VERSION.SDK_INT>=28?PackageManager.GET_SIGNING_CERTIFICATES:PackageManager.GET_SIGNATURES;
        PackageInfo installed=pm.getPackageInfo(getApplicationContext().getPackageName(),flags);
        PackageInfo parsed=pm.getPackageArchiveInfo(archive.getAbsolutePath(),flags);
        if(parsed==null)return false;
        android.content.pm.Signature[] a=Build.VERSION.SDK_INT>=28&&installed.signingInfo!=null?installed.signingInfo.getApkContentsSigners():installed.signatures;
        android.content.pm.Signature[] b=Build.VERSION.SDK_INT>=28&&parsed.signingInfo!=null?parsed.signingInfo.getApkContentsSigners():parsed.signatures;
        if(a==null||b==null||a.length==0||b.length==0)return false;
        java.util.HashSet<String>x=new java.util.HashSet<>(),y=new java.util.HashSet<>();for(android.content.pm.Signature s:a)x.add(bytesHex(s.toByteArray()));for(android.content.pm.Signature s:b)y.add(bytesHex(s.toByteArray()));return x.equals(y);
    }
    private static String bytesHex(byte[]bytes)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");StringBuilder s=new StringBuilder();for(byte b:d.digest(bytes))s.append(String.format(Locale.US,"%02x",b));return s.toString();}
    private static String sha256(File file)throws Exception{MessageDigest d=MessageDigest.getInstance("SHA-256");try(FileInputStream in=new FileInputStream(file)){byte[]b=new byte[32768];int n;while((n=in.read(b))!=-1)d.update(b,0,n);}StringBuilder s=new StringBuilder();for(byte b:d.digest())s.append(String.format(Locale.US,"%02x",b));return s.toString();}
}
