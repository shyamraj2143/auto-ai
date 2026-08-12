package com.autoai.app;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.PowerManager;
import android.util.Log;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public class AutoAiFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "AutoAiFcm";
    private static final int UPDATE_NOTIFICATION_ID = 1001;
    private static final String CHAT_NOTIFICATION_CHANNEL_ID = "auto_ai_messages";
    private static final String MISSED_CALL_CHANNEL_ID = "auto_ai_missed_calls";
    private static final String SOCIAL_CHANNEL_ID = "auto_ai_social";
    private static final String RELATIONSHIP_CHANNEL_ID = "auto_ai_relationship_followups";
    private static final String SEVA_CHANNEL_ID = "auto_ai_seva_cases";
    private static final String UPDATE_PREFERENCES = "auto_ai_update_preferences";
    private static final String LAST_NOTIFIED_UPDATE_VERSION_CODE = "last_notified_update_version_code";
    private static final long UPDATE_CHECK_LISTENER_TIMEOUT_MS = 95_000L;

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.i(TAG, "FCM token rotated; scheduling backend registration.");
        PushTokenRegistrar.registerAsync(this, token);
    }

    @Override
    public void onRegistered(@NonNull String installationId) {
        super.onRegistered(installationId);
        Log.i(TAG, "FCM installation registered fid_hash=" + PushTokenRegistrar.sha256Prefix(installationId));
        PushTokenRegistrar.registerInstallationAsync(this, installationId);
    }

    @Override
    public void onUnregistered(@NonNull String installationId) {
        super.onUnregistered(installationId);
        Log.i(TAG, "FCM installation unregistered fid_hash=" + PushTokenRegistrar.sha256Prefix(installationId));
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String messageType = data.get("type");
        String callId = data.get("call_id");
        long callRevision = parseInt(data.get("call_revision"));
        Log.i(TAG, "FCM received type=" + messageType + " callId=" + data.get("call_id"));
        if ("alarm_sync".equals(messageType)) {
            String alarmId = data.get("alarm_id");
            String alarmAction = data.get("action");
            if (alarmId == null || alarmId.trim().isEmpty()) return;
            if ("delete".equals(alarmAction)) {
                AlarmActionReceiver.cancelFromSync(this, alarmId, true);
                return;
            }
            AlarmPayload alarm = AlarmPayload.fromData(data);
            if (alarm == null || !AlarmStore.upsert(this, alarm)) return;
            if ("cancel".equals(alarmAction) || !alarm.enabled) {
                AlarmActionReceiver.cancelFromSync(this, alarmId, false);
            } else {
                AlarmScheduler.schedule(this, alarm);
                AlarmActionReceiver.broadcast(this, alarmId, "schedule");
            }
            return;
        }
        if ("incoming_call".equals(messageType) || "incoming_call_fallback".equals(messageType)) {
            String priorityResult = message.getOriginalPriority() == RemoteMessage.PRIORITY_HIGH
                ? (message.getPriority() == RemoteMessage.PRIORITY_HIGH ? "HIGH_DELIVERED_AS_HIGH" : "HIGH_DOWNGRADED_TO_NORMAL")
                : "ORIGINAL_PRIORITY_NOT_HIGH";
            long ageMs = message.getSentTime() > 0 ? Math.max(0L, System.currentTimeMillis() - message.getSentTime()) : -1L;
            PowerManager.WakeLock wakeLock = null;
            try {
                PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
                if (powerManager != null) {
                    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autoai:incoming-call");
                    wakeLock.acquire(10_000L);
                }
                String messageDiagnostic = priorityResult + ":age_ms=" + ageMs + ":message_id_hash="
                    + PushTokenRegistrar.sha256Prefix(message.getMessageId());
                CallNotificationManager.diagnostic(this, "FIREBASE_SERVICE_STARTED", data, messageDiagnostic);
                CallDeliveryAckWorker.schedule(this, data, "firebase_service_started", String.valueOf(message.getOriginalPriority()), String.valueOf(message.getPriority()));
                CallNotificationManager.diagnostic(this,
                    "incoming_call_fallback".equals(messageType) ? "DEGRADED_SYSTEM_FALLBACK_ONLY" : "PRIMARY_DEVICE_RECEIVED",
                    data, priorityResult);
                if ("incoming_call".equals(messageType)) {
                    CallNotificationManager.diagnostic(this,
                        "HIGH_DOWNGRADED_TO_NORMAL".equals(priorityResult) ? "PRIMARY_PRIORITY_DOWNGRADED" : priorityResult,
                        data, priorityResult);
                    if (!"HIGH_DELIVERED_AS_HIGH".equals(priorityResult)) FcmInstallationMigrationWorker.schedule(this);
                }
                CallNotificationManager.showIncoming(this, data);
                CallDeliveryAckWorker.schedule(this, data, "device_received", String.valueOf(message.getOriginalPriority()), String.valueOf(message.getPriority()));
            } finally {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            }
            return;
        }
        if ("call_missed".equals(messageType)) {
            if (!CallNotificationManager.acceptRevision(this, callId, callRevision)) return;
            CallNotificationManager.cancelAllForCall(this, data.get("call_id"));
            if (Boolean.parseBoolean(data.get("show_missed"))) showMissedCallNotification(data);
            return;
        }
        if ("call_accepted".equals(messageType)) {
            if (!CallNotificationManager.acceptRevision(this, callId, callRevision)) return;
            CallNotificationManager.cancelIncomingPresentation(this, callId);
            return;
        }
        if ("call_failed".equals(messageType) || "call_ended".equals(messageType)
            || "call_cancelled".equals(messageType) || "call_rejected".equals(messageType)) {
            if (!CallNotificationManager.acceptRevision(this, callId, callRevision)) return;
            CallNotificationManager.cancelAllForCall(this, data.get("call_id"));
            return;
        }
        if (messageType != null && messageType.startsWith("call_")) {
            CallNotificationManager.cancel(this, data.get("call_id"));
            return;
        }
        if ("chat_message".equals(messageType)) {
            showChatNotification(data, message.getNotification());
            return;
        }
        if ("follow_request".equals(messageType) || "follow_accept".equals(messageType)) {
            showSocialNotification(data, message.getNotification());
            return;
        }
        if ("relationship_followup".equals(messageType)) {
            showRelationshipNotification(data, message.getNotification());
            return;
        }
        if ("seva_case_update".equals(messageType)) {
            showSevaNotification(data, message.getNotification());
            return;
        }
        if ("apk_update".equals(messageType)) {
            notifyAfterVerifiedUpdateCheck();
            return;
        }
        int versionCode = parseInt(data.get("version_code"));
        if (versionCode > 0 && versionCode <= BuildConfig.VERSION_CODE) return;

        String title = data.get("title");
        String body = data.get("body");
        RemoteMessage.Notification notification = message.getNotification();
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI update available";
        if (body == null || body.trim().isEmpty()) {
            String versionName = data.get("version_name");
            body = versionName == null || versionName.trim().isEmpty()
                ? "A new Auto-AI app update is ready to install."
                : "Version " + versionName + " is ready to install.";
        }
        showNotification(versionCode, title, body);
    }

    private void notifyAfterVerifiedUpdateCheck() {
        try {
            UpdateCheckScheduler.schedule(this);
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to schedule durable pushed APK update check.", error);
        }
        try {
            new UpdateNotificationListener(
                AppUpdateCoordinator.get(this),
                new Handler(getMainLooper())
            ).start();
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to start pushed APK update check.", error);
        }
    }

    static boolean shouldNotifyForVerifiedUpdate(
        AppUpdateCoordinator.Snapshot snapshot,
        int installedVersionCode
    ) {
        if (snapshot == null || snapshot.metadata == null
            || snapshot.metadata.versionCode <= installedVersionCode) return false;
        return snapshot.state == AppUpdateCoordinator.State.AVAILABLE
            || snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL;
    }

    static boolean isTerminalUpdateCheckState(AppUpdateCoordinator.State state) {
        return state == AppUpdateCoordinator.State.UP_TO_DATE
            || state == AppUpdateCoordinator.State.FAILED
            || state == AppUpdateCoordinator.State.INSTALLED
            || state == AppUpdateCoordinator.State.IDLE;
    }

    private final class UpdateNotificationListener implements AppUpdateCoordinator.Listener {
        private final AppUpdateCoordinator coordinator;
        private final Handler mainHandler;
        private final AtomicBoolean armed = new AtomicBoolean(false);
        private final AtomicBoolean stopped = new AtomicBoolean(false);
        private final Runnable timeout = this::stop;

        UpdateNotificationListener(AppUpdateCoordinator coordinator, Handler mainHandler) {
            this.coordinator = coordinator;
            this.mainHandler = mainHandler;
        }

        void start() {
            mainHandler.postDelayed(timeout, UPDATE_CHECK_LISTENER_TIMEOUT_MS);
            try {
                coordinator.addListener(this);
                armed.set(true);
                coordinator.check(true);
            } catch (RuntimeException error) {
                Log.w(TAG, "Pushed APK update check failed to start.", error);
                stop();
            }
        }

        @Override
        public void onUpdateChanged(AppUpdateCoordinator.Snapshot snapshot) {
            if (!armed.get() || stopped.get()) return;
            try {
                if (shouldNotifyForVerifiedUpdate(snapshot, BuildConfig.VERSION_CODE)) {
                    AppUpdateCoordinator.Metadata metadata = snapshot.metadata;
                    int versionCode = metadata.versionCode;
                    String versionName = metadata.versionName;
                    String changelog = metadata.changelog;
                    if (!stop()) return;
                    mainHandler.post(() -> {
                        try {
                            if (isAppInForeground()) {
                                Intent updateIntent = new Intent(AutoAiFirebaseMessagingService.this, MainActivity.class)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                                    .putExtra("start_app_update", true)
                                    .putExtra("open_app_update", true);
                                startActivity(updateIntent);
                            } else {
                                showNotification(versionCode, "AutoAI " + versionName + " update",
                                    changelog == null || changelog.trim().isEmpty()
                                        ? "A verified AutoAI update is ready."
                                        : changelog.trim());
                            }
                        } catch (RuntimeException error) {
                            Log.w(TAG, "Unable to present pushed APK update surface.", error);
                            showNotification(versionCode, "AutoAI " + versionName + " update",
                                changelog == null || changelog.trim().isEmpty()
                                    ? "A verified AutoAI update is ready."
                                    : changelog.trim());
                        }
                    });
                    return;
                }
                if (isTerminalUpdateCheckState(snapshot == null ? null : snapshot.state)) stop();
            } catch (RuntimeException error) {
                Log.w(TAG, "Pushed APK update listener failed.", error);
                stop();
            }
        }

        private boolean stop() {
            if (!stopped.compareAndSet(false, true)) return false;
            mainHandler.removeCallbacks(timeout);
            coordinator.removeListener(this);
            return true;
        }
    }

    private boolean isAppInForeground() {
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            for (android.app.ActivityManager.RunningAppProcessInfo process : manager.getRunningAppProcesses()) {
                if (getPackageName().equals(process.processName)) {
                    return process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
                        || process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE;
                }
            }
            return false;
        }
        for (android.app.ActivityManager.RunningTaskInfo task : manager.getRunningTasks(1)) {
            if (task.topActivity != null && getPackageName().equals(task.topActivity.getPackageName())) return true;
        }
        return false;
    }

    @Override
    public void onDeletedMessages() {
        super.onDeletedMessages();
        Log.w(TAG, "FCM_DELETED_MESSAGES");
        PushTokenRegistrar.registerStoredUserDeviceIfAuthenticated(this);
    }

    private void showChatNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createChatNotificationChannel();
        String threadId = data.get("thread_id");
        if (threadId == null || threadId.trim().isEmpty()) return;
        String messageId = data.get("message_id");
        String title = data.get("sender_name");
        String body = data.get("preview");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI message";
        if (body == null || body.trim().isEmpty()) body = "New message";

        Intent intent = NotificationDeepLink.activityIntent(
            this, NotificationDeepLink.Destination.MESSAGE_THREAD, threadId, null,
            data.get("event_id"), parseLong(data.get("expires_at_epoch_ms"))
        ).putExtra("open_chat_thread_id", threadId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("chat_message", threadId, "open"), intent, flags);
        PendingIntent markRead = PendingIntent.getBroadcast(
            this,
            6100 + Math.abs(threadId.hashCode() % 100000),
            MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_MARK_READ, threadId, messageId),
            flags
        );
        PendingIntent mute = PendingIntent.getBroadcast(
            this,
            6200 + Math.abs(threadId.hashCode() % 100000),
            MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_MUTE, threadId, messageId),
            flags
        );
        Intent replyIntent = MessageActionReceiver.intent(this, MessageActionReceiver.ACTION_REPLY, threadId, messageId);
        PendingIntent reply = PendingIntent.getBroadcast(this, 6300 + Math.abs(threadId.hashCode() % 100000), replyIntent, mutablePendingFlags());
        RemoteInput remoteInput = new RemoteInput.Builder(MessageActionReceiver.KEY_TEXT_REPLY)
            .setLabel("Reply")
            .build();

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHAT_NOTIFICATION_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_send, "Reply", reply).addRemoteInput(remoteInput).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_view, "Mark read", markRead).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_lock_silent_mode, "Mute", mute).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(5000 + Math.abs(threadId.hashCode() % 100000), builder.build());
    }

    private void showMissedCallNotification(Map<String, String> data) {
        if (!canPostNotifications()) return;
        createMissedCallNotificationChannel();
        String callId = data.get("call_id");
        if (callId == null || callId.trim().isEmpty()) return;
        String callType = "audio".equals(data.get("call_type")) ? "audio" : "video";
        PendingIntent pendingIntent = NotificationDeepLink.pendingActivity(
            this, NotificationDeepLink.Destination.MISSED_CALL, callId, null,
            data.get("event_id"), "open", 0L
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, MISSED_CALL_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Missed Auto-AI call")
            .setContentText("You missed an " + callType + " call")
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(7000 + Math.abs(callId.hashCode() % 100000), builder.build());
    }

    private void showNotification(int versionCode, String title, String body) {
        if (!canPostNotifications()) return;
        if (versionCode > 0) {
            int lastNotifiedVersion = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
                .getInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, 0);
            if (lastNotifiedVersion >= versionCode) return;
        }

        createUpdateNotificationChannel();
        Intent intent = NotificationDeepLink.activityIntent(this, NotificationDeepLink.Destination.APP_UPDATE, null, null, "apk_update:" + versionCode, 0L)
            .putExtra("start_app_update", true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("apk_update", String.valueOf(versionCode), "details"), intent, flags);
        Intent updateIntent = NotificationDeepLink.activityIntent(this, NotificationDeepLink.Destination.APP_UPDATE, null, null, "apk_update:" + versionCode, 0L).putExtra("start_app_update", true);
        PendingIntent updateNow = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("apk_update", String.valueOf(versionCode), "install"), updateIntent, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, UpdateNotificationChannel.ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.stat_sys_download_done, "Update Now", updateNow).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_info_details, "View Details", pendingIntent).build());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
        }

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.notify(UPDATE_NOTIFICATION_ID, builder.build());
        if (versionCode > 0) {
            getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE)
                .edit()
                .putInt(LAST_NOTIFIED_UPDATE_VERSION_CODE, versionCode)
                .apply();
        }
    }

    private void createUpdateNotificationChannel() {
        UpdateNotificationChannel.create(this);
    }

    private void showSocialNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createMissedCallNotificationChannel();
        String actor = data.get("actor_name");
        String title = data.get("title");
        String body = data.get("body");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI social update";
        if (body == null || body.trim().isEmpty()) body = actor == null ? "You have a new social update." : actor + " sent you a social update.";
        Intent intent = NotificationDeepLink.activityIntent(this, NotificationDeepLink.Destination.SOCIAL, data.get("user_id"), null, data.get("event_id"), 0L);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("social", data.get("user_id"), "open"), intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, SOCIAL_CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body).setContentIntent(pendingIntent).setAutoCancel(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(8000 + Math.abs(String.valueOf(data.get("event_id")).hashCode() % 100000), builder.build());
    }

    private void showRelationshipNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createRelationshipNotificationChannel(this);
        String contactId = data.get("contact_id");
        String title = data.get("title");
        String body = data.get("body");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI follow-up";
        if (body == null || body.trim().isEmpty()) body = "You have a relationship follow-up.";
        Intent intent = NotificationDeepLink.activityIntent(this, NotificationDeepLink.Destination.RELATIONSHIP, contactId, null, data.get("event_id"), 0L);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("relationship", contactId, "open"), intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, RELATIONSHIP_CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body).setContentIntent(pendingIntent).setAutoCancel(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(9000 + Math.abs(String.valueOf(contactId).hashCode() % 100000), builder.build());
    }

    private void showSevaNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createSevaNotificationChannel();
        String applicationId = data.get("application_id");
        String title = data.get("title");
        String body = data.get("body");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "AutoAI Seva update";
        if (body == null || body.trim().isEmpty()) body = "Your Seva application has an update.";
        Intent intent = NotificationDeepLink.activityIntent(this, NotificationDeepLink.Destination.SEVA, applicationId, null, data.get("event_id"), 0L);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pendingIntent = PendingIntent.getActivity(this, NotificationDeepLink.requestCode("seva", applicationId, "open"), intent, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, SEVA_CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body).setContentIntent(pendingIntent).setAutoCancel(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(9500 + Math.abs(String.valueOf(applicationId).hashCode() % 100000), builder.build());
    }

    private void createChatNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(CHAT_NOTIFICATION_CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH));
    }

    static int parseInt(String value) {
        try { return Integer.parseInt(value == null ? "" : value); } catch (Exception ignored) { return 0; }
    }

    private long parseLong(String value) {
        try { return Long.parseLong(value == null ? "" : value); } catch (Exception ignored) { return 0L; }
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    public static void createRelationshipNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(RELATIONSHIP_CHANNEL_ID, "Relationship follow-ups", NotificationManager.IMPORTANCE_HIGH));
    }

    private void createMissedCallNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(MISSED_CALL_CHANNEL_ID, "Missed calls", NotificationManager.IMPORTANCE_HIGH));
    }

    private void createSevaNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(SEVA_CHANNEL_ID, "AutoAI Seva", NotificationManager.IMPORTANCE_HIGH));
    }

    private int mutablePendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_MUTABLE;
        return flags;
    }
}
