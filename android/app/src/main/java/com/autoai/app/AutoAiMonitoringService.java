package com.autoai.app;

import android.Manifest;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.StatFs;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.Nullable;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.tasks.Tasks;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class AutoAiMonitoringService extends Service {
    private static final String TAG = "AutoAiMonitor";
    private static final int NOTIFICATION_ID = 4301;
    private static final String CHANNEL_ID = "auto_ai_device_monitoring";
    private static final int CONNECT_TIMEOUT_MS = 10000;
    private static final int READ_TIMEOUT_MS = 20000;
    private static final int MAX_QUEUE_ROWS = 1000;

    private ScheduledExecutorService executor;
    private PendingDataStore pendingDataStore;
    private FusedLocationProviderClient locationClient;
    private boolean scheduled;

    public static void start(Context context) {
        Intent intent = new Intent(context, AutoAiMonitoringService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void clearLocalCache(Context context) {
        new PendingDataStore(context.getApplicationContext()).clear();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        pendingDataStore = new PendingDataStore(getApplicationContext());
        locationClient = LocationServices.getFusedLocationProviderClient(this);
        executor = Executors.newSingleThreadScheduledExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, monitoringNotification());
        if (executor == null || executor.isShutdown()) {
            executor = Executors.newSingleThreadScheduledExecutor();
        }
        if (!scheduled) {
            executor.scheduleAtFixedRate(this::collectAndSend, 0, 1, TimeUnit.SECONDS);
            scheduled = true;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        scheduled = false;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification monitoringNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 4301, intent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Auto-AI is monitoring device")
            .setContentText("Device telemetry is being shared with your admin dashboard.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_LOW);
        }
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Device monitoring",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Visible foreground service for Auto-AI device telemetry");
        manager.createNotificationChannel(channel);
    }

    private void collectAndSend() {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(this, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) {
            Log.i(TAG, "Stopping monitor; no authenticated user token.");
            stopSelf();
            return;
        }
        try {
            JSONObject payload = collectPayload();
            if (sendPayload(accessToken.trim(), payload)) {
                syncQueued(accessToken.trim());
            } else {
                pendingDataStore.enqueue(payload.toString());
            }
        } catch (Exception error) {
            Log.w(TAG, "Device telemetry collection failed.", error);
        }
    }

    private JSONObject collectPayload() throws Exception {
        JSONObject payload = new JSONObject();
        long storageTotal = storageTotalBytes();
        long storageFree = storageFreeBytes();
        long storageUsed = Math.max(0L, storageTotal - storageFree);
        ActivityManager.MemoryInfo memory = memoryInfo();
        long ramUsed = memory == null ? 0L : Math.max(0L, memory.totalMem - memory.availMem);
        payload.put("timestamp", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(new java.util.Date()));
        payload.put("deviceId", PushTokenRegistrar.deviceId(this, "auto_ai_call_device", "fallback_device_id"));
        payload.put("type", "mobile");
        payload.put("battery", batteryLevel());
        payload.put("screenOn", screenOn());
        payload.put("currentApp", currentForegroundApp());
        payload.put("network", networkType());
        payload.put("storageTotal", formatBytes(storageTotal));
        payload.put("storageUsed", formatBytes(storageUsed));
        payload.put("storageFree", formatBytes(storageFree));
        if (memory != null) {
            payload.put("ramTotal", formatBytes(memory.totalMem));
            payload.put("ramUsed", formatBytes(ramUsed));
            payload.put("ramUsage", formatBytes(ramUsed) + " / " + formatBytes(memory.totalMem));
        }
        payload.put("deviceModel", deviceModel());
        payload.put("osVersion", Build.VERSION.RELEASE == null ? "Android" : Build.VERSION.RELEASE);
        payload.put("isActive", true);
        JSONObject location = lastLocationJson();
        if (location != null) payload.put("location", location);
        return payload;
    }

    private int batteryLevel() {
        BatteryManager batteryManager = (BatteryManager) getSystemService(BATTERY_SERVICE);
        if (batteryManager == null) return 0;
        int value = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        return Math.max(0, Math.min(100, value));
    }

    private boolean screenOn() {
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        return powerManager != null && powerManager.isInteractive();
    }

    private String currentForegroundApp() {
        if (!hasUsageStatsPermission()) return "permission_required";
        UsageStatsManager manager = (UsageStatsManager) getSystemService(USAGE_STATS_SERVICE);
        if (manager == null) return "unknown";
        long now = System.currentTimeMillis();
        List<UsageStats> stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 60000L, now);
        UsageStats latest = null;
        for (UsageStats stat : stats) {
            if (latest == null || stat.getLastTimeUsed() > latest.getLastTimeUsed()) latest = stat;
        }
        return latest == null ? "unknown" : latest.getPackageName();
    }

    private boolean hasUsageStatsPermission() {
        UsageStatsManager manager = (UsageStatsManager) getSystemService(USAGE_STATS_SERVICE);
        if (manager == null) return false;
        long now = System.currentTimeMillis();
        List<UsageStats> stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - 60000L, now);
        return stats != null && !stats.isEmpty();
    }

    private JSONObject lastLocationJson() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return null;
        try {
            android.location.Location location = Tasks.await(locationClient.getLastLocation(), 800, TimeUnit.MILLISECONDS);
            if (location == null) return null;
            JSONObject value = new JSONObject();
            value.put("lat", location.getLatitude());
            value.put("lng", location.getLongitude());
            return value;
        } catch (Exception ignored) {
            return null;
        }
    }

    private String networkType() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return "unknown";
        Network network = manager.getActiveNetwork();
        if (network == null) return "offline";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
        if (capabilities == null) return "unknown";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return "vpn";
        return "other";
    }

    private long storageFreeBytes() {
        StatFs statFs = new StatFs(Environment.getDataDirectory().getAbsolutePath());
        return statFs.getAvailableBytes();
    }

    private long storageTotalBytes() {
        StatFs statFs = new StatFs(Environment.getDataDirectory().getAbsolutePath());
        return statFs.getTotalBytes();
    }

    private ActivityManager.MemoryInfo memoryInfo() {
        ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        if (manager == null) return null;
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        manager.getMemoryInfo(info);
        return info;
    }

    private String deviceModel() {
        String value = ((Build.MANUFACTURER == null ? "" : Build.MANUFACTURER) + " " + (Build.MODEL == null ? "" : Build.MODEL)).trim();
        return value.isEmpty() ? "Android device" : value;
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024L * 1024L) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024L * 1024L * 1024L) return String.format(Locale.US, "%.1f MB", bytes / 1024.0 / 1024.0);
        return String.format(Locale.US, "%.2f GB", bytes / 1024.0 / 1024.0 / 1024.0);
    }

    private boolean sendPayload(String accessToken, JSONObject payload) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(trimTrailingSlash(BuildConfig.AUTO_AI_API_BASE_URL) + "/device/activity");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception error) {
            Log.w(TAG, "Device telemetry send failed.", error);
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void syncQueued(String accessToken) {
        List<PendingData> rows = pendingDataStore.take(25);
        for (PendingData row : rows) {
            try {
                if (sendPayload(accessToken, new JSONObject(row.jsonData))) {
                    pendingDataStore.delete(row.id);
                } else {
                    return;
                }
            } catch (Exception ignored) {
                return;
            }
        }
    }

    private String trimTrailingSlash(String value) {
        return value == null ? "" : value.replaceAll("/+$", "");
    }

    private static final class PendingData {
        final long id;
        final String jsonData;

        PendingData(long id, String jsonData) {
            this.id = id;
            this.jsonData = jsonData;
        }
    }

    private static final class PendingDataStore extends SQLiteOpenHelper {
        PendingDataStore(Context context) {
            super(context, "auto_ai_monitoring.db", null, 1);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS pending_data (id INTEGER PRIMARY KEY AUTOINCREMENT, json_data TEXT NOT NULL, created_at INTEGER NOT NULL)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            onCreate(db);
        }

        void enqueue(String jsonData) {
            SQLiteDatabase db = getWritableDatabase();
            db.execSQL("INSERT INTO pending_data (json_data, created_at) VALUES (?, ?)", new Object[]{jsonData, System.currentTimeMillis()});
            db.execSQL("DELETE FROM pending_data WHERE id NOT IN (SELECT id FROM pending_data ORDER BY id DESC LIMIT " + MAX_QUEUE_ROWS + ")");
        }

        List<PendingData> take(int limit) {
            java.util.ArrayList<PendingData> rows = new java.util.ArrayList<>();
            Cursor cursor = getReadableDatabase().rawQuery("SELECT id, json_data FROM pending_data ORDER BY id ASC LIMIT ?", new String[]{String.valueOf(limit)});
            try {
                while (cursor.moveToNext()) rows.add(new PendingData(cursor.getLong(0), cursor.getString(1)));
            } finally {
                cursor.close();
            }
            return rows;
        }

        void delete(long id) {
            getWritableDatabase().delete("pending_data", "id = ?", new String[]{String.valueOf(id)});
        }

        void clear() {
            getWritableDatabase().delete("pending_data", null, null);
        }
    }
}
