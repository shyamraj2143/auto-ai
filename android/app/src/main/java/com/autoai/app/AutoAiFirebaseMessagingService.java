package com.autoai.app;

import android.Manifest;
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
    private static final String UPDATE_NOTIFICATION_CHANNEL_ID = "app_updates";
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
            // Accept is a handoff, not a terminal event. Only remove the ringing
            // presentation; the foreground service and native media session must live on.
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
            // Push data is routing-only. The coordinator fetches signed release metadata from the API.
            notifyAfterVerifiedUpdateCheck();
            return;
        }
        int versionCode = parseInt(data.get("version_code"));
        if (versionCode > 0 && versionCode <= BuildConfig.VERSION_CODE) return;

        String title = data.get("title");
        String body = data.get("body");
        RemoteMessage.Notification notification = message.getNotification();
        if ((title == null || title.trim().isEmpty()) && notification != null) {
            title = notification.getTitle();
        }
        if ((body == null || body.trim().isEmpty()) && notification != null) {
            body = notification.getBody();
        }
        if (title == null || title.trim().isEmpty()) {
            title = "Auto-AI update available";
        }
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
            // FCM may reclaim this service after onMessageReceived returns. Keep the
            // same verified check durable so delivery does not depend on this process.
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

    /** One-shot listener for a routing-only FCM update event. */
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
                // addListener publishes the current snapshot synchronously. Ignore that
                // stale value until this instance is armed for its own refresh.
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
                            showNotification(versionCode, "AutoAI " + versionName + " update",
                                changelog == null || changelog.trim().isEmpty()
                                    ? "A verified AutoAI update is ready."
                                    : changelog.trim());
                        } catch (RuntimeException error) {
                            Log.w(TAG, "Unable to show pushed APK update notification.", error);
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
            ? new Notification.Builder(this, UPDATE_NOTIFICATION_CHANNEL_ID)
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

    private void showSocialNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createMissedCallNotificationChannel();
        String type = data.get("type");
        String entityId = data.get("entity_id");
        NotificationDeepLink.Destination destination = "follow_request".equals(type)
            ? NotificationDeepLink.Destination.FOLLOW_REQUEST
            : NotificationDeepLink.Destination.FOLLOW_ACCEPTED;
        if (entityId == null || entityId.trim().isEmpty()) return;
        String title = data.get("title");
        String body = data.get("body");
        if ((title == null || title.trim().isEmpty()) && notification != null) title = notification.getTitle();
        if ((body == null || body.trim().isEmpty()) && notification != null) body = notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Auto-AI connection";
        if (body == null || body.trim().isEmpty()) body = "Open to view details";
        PendingIntent open = NotificationDeepLink.pendingActivity(this, destination, entityId, null, data.get("event_id"), "open", 0L);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, SOCIAL_CHANNEL_ID) : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body)).setContentIntent(open)
            .setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).setWhen(System.currentTimeMillis());
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NotificationDeepLink.requestCode(type, entityId, "notification"), builder.build());
    }

    private void createChatNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHAT_NOTIFICATION_CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Auto-AI message alerts");
        manager.createNotificationChannel(channel);
    }

    private void showRelationshipNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        createRelationshipNotificationChannel(this);
        String contactId = data.get("contact_id");
        if (contactId == null || contactId.trim().isEmpty()) return;
        String title = notification == null ? null : notification.getTitle();
        String body = notification == null ? null : notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "Relationship follow-up";
        if (body == null || body.trim().isEmpty()) body = "You have a relationship follow-up reminder.";
        PendingIntent open = NotificationDeepLink.pendingActivity(
            this,
            NotificationDeepLink.Destination.RELATIONSHIP_FOLLOWUP,
            contactId,
            null,
            data.get("event_id"),
            "open",
            0L
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, RELATIONSHIP_CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NotificationDeepLink.requestCode("relationship_followup", contactId, "notification"), builder.build());
    }

    private void showSevaNotification(Map<String, String> data, RemoteMessage.Notification notification) {
        if (!canPostNotifications()) return;
        String caseRouteId = data.get("case_route_id");
        if (caseRouteId == null || caseRouteId.trim().isEmpty()) return;
        String title = notification == null ? data.get("title") : notification.getTitle();
        String body = notification == null ? data.get("body") : notification.getBody();
        if (title == null || title.trim().isEmpty()) title = "AutoAI Seva update";
        if (body == null || body.trim().isEmpty()) body = "Your Seva case has been updated.";
        createSevaNotificationChannel();
        PendingIntent open = NotificationDeepLink.pendingActivity(
            this, NotificationDeepLink.Destination.SEVA_CASE, caseRouteId, data.get("secondary_id"),
            data.get("event_id"), "open", 0L
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, SEVA_CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis());
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_HIGH);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NotificationDeepLink.requestCode("seva_case_update", caseRouteId, "notification"), builder.build());
    }

    private void createSevaNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(SEVA_CHANNEL_ID, "Seva case updates", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Assignment, requirement and status updates for AutoAI Seva cases");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    public static void createRelationshipNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            RELATIONSHIP_CHANNEL_ID,
            "Relationship reminders",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Reminders to follow up with important people");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
    }

    private void createMissedCallNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel missed = new NotificationChannel(
            MISSED_CALL_CHANNEL_ID,
            "Missed calls",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        missed.setDescription("Auto-AI missed call alerts");
        manager.createNotificationChannel(missed);
        NotificationChannel social = new NotificationChannel(
            SOCIAL_CHANNEL_ID,
            "Social",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        social.setDescription("Auto-AI social and follow alerts");
        manager.createNotificationChannel(social);
    }

    private boolean canPostNotifications() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private int mutablePendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return flags;
    }

    private int parseInt(String value) {
        if (value == null) return 0;
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    private long parseLong(String value) {
        if (value == null) return 0L;
        try { return Long.parseLong(value.trim()); }
        catch (NumberFormatException ignored) { return 0L; }
    }

}
