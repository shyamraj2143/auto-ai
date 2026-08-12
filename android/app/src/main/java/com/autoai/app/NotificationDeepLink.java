package com.autoai.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

public final class NotificationDeepLink {
    public static final String EXTRA_DESTINATION = "notification_destination";
    public static final String EXTRA_EVENT_ID = "notification_event_id";
    public static final String EXTRA_ENTITY_ID = "notification_entity_id";
    public static final String EXTRA_SECONDARY_ID = "notification_secondary_id";
    public static final String EXTRA_EXPIRES_AT = "notification_expires_at";
    private static final String PREFS = "auto_ai_notification_destinations";
    private static final String PENDING = "pending";
    private static final String SEEN = "seen";
    private static final int MAX_SEEN = 200;

    public enum Destination {
        MESSAGE_THREAD, AI_CONVERSATION, INCOMING_CALL, MISSED_CALL, CALL_HISTORY,
        FOLLOW_REQUEST, FOLLOW_ACCEPTED, SOCIAL_ALERT, SCREEN_SHARE_SESSION,
        APP_UPDATE, SETTINGS_SECTION, PAYMENT_RESULT, RELATIONSHIP_FOLLOWUP, SEVA_CASE,
        // Legacy aliases kept for compatibility with older FCM notification code.
        SOCIAL, RELATIONSHIP, SEVA
    }

    private NotificationDeepLink() { }

    public static Intent activityIntent(Context context, Destination destination, String entityId, String secondaryId, String eventId, long expiresAt) {
        Destination canonical = canonicalDestination(destination);
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_DESTINATION, canonical.name())
            .putExtra(EXTRA_EVENT_ID, clean(eventId) == null ? UUID.randomUUID().toString() : clean(eventId));
        if (clean(entityId) != null) intent.putExtra(EXTRA_ENTITY_ID, clean(entityId));
        if (clean(secondaryId) != null) intent.putExtra(EXTRA_SECONDARY_ID, clean(secondaryId));
        if (expiresAt > 0L) intent.putExtra(EXTRA_EXPIRES_AT, expiresAt);
        return intent;
    }

    public static PendingIntent pendingActivity(Context context, Destination destination, String entityId, String secondaryId, String eventId, String action, long expiresAt) {
        Intent intent = activityIntent(context, destination, entityId, secondaryId, eventId, expiresAt);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, requestCode(canonicalDestination(destination).name(), entityId, action), intent, flags);
    }

    static int requestCode(String type, String entityId, String action) {
        String identity = String.valueOf(type) + ":" + String.valueOf(entityId) + ":" + String.valueOf(action);
        return 100000 + Math.abs(identity.hashCode() % 800000);
    }

    public static boolean capture(Context context, Intent intent) {
        JSONObject payload = parse(intent);
        if (payload == null) return false;
        String destination = payload.optString("destination", "");
        if (Destination.INCOMING_CALL.name().equals(destination) || Destination.APP_UPDATE.name().equals(destination)) return false;
        String eventId = payload.optString("eventId", "");
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getStringSet(SEEN, new HashSet<>()).contains(eventId)) return false;
        prefs.edit().putString(PENDING, payload.toString()).apply();
        return true;
    }

    public static boolean dispatchPending(MainActivity activity) {
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(PENDING, null);
        if (raw == null) return false;
        WebView webView = activity.getBridge() == null ? null : activity.getBridge().getWebView();
        if (webView == null || webView.getProgress() < 100) return false;
        try {
            JSONObject payload = new JSONObject(raw);
            String eventId = payload.optString("eventId", "");
            String quoted = JSONObject.quote(raw);
            String script = "(function(){var raw=" + quoted + ";localStorage.setItem('auto-ai-pending-destination',raw);window.dispatchEvent(new CustomEvent('auto-ai-open-destination',{detail:JSON.parse(raw)}));return 'ok';})()";
            webView.evaluateJavascript(script, ignored -> markConsumed(prefs, eventId));
            return true;
        } catch (Exception invalid) {
            prefs.edit().remove(PENDING).apply();
            return false;
        }
    }

    public static boolean hasPending(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(PENDING);
    }

    private static JSONObject parse(Intent intent) {
        if (intent == null) return null;
        String type = clean(intent.getStringExtra(EXTRA_DESTINATION));
        if (type == null) type = destinationForLegacyType(clean(intent.getStringExtra("destination")), clean(intent.getStringExtra("type")));
        if (type == null && clean(intent.getStringExtra("open_chat_thread_id")) != null) type = Destination.MESSAGE_THREAD.name();
        Destination destination;
        try { destination = Destination.valueOf(type == null ? "" : type); }
        catch (IllegalArgumentException invalid) { return null; }
        destination = canonicalDestination(destination);
        String entityId = first(intent, EXTRA_ENTITY_ID, "entity_id", requiredField(destination));
        if (entityId == null && destination == Destination.MESSAGE_THREAD) entityId = clean(intent.getStringExtra("open_chat_thread_id"));
        if (requiresEntity(destination) && entityId == null) return null;
        long expiresAt = intent.getLongExtra(EXTRA_EXPIRES_AT, 0L);
        if (expiresAt <= 0L) expiresAt = parseLong(intent.getStringExtra("expires_at_epoch_ms"));
        if (expiresAt > 0L && expiresAt <= System.currentTimeMillis()) return null;
        String eventId = first(intent, EXTRA_EVENT_ID, "event_id", null);
        if (eventId == null) eventId = destination.name() + ":" + String.valueOf(entityId);
        try {
            JSONObject payload = new JSONObject();
            payload.put("eventId", eventId);
            payload.put("destination", destination.name());
            payload.put("entityId", entityId == null ? JSONObject.NULL : entityId);
            String secondaryId = first(intent, EXTRA_SECONDARY_ID, "secondary_id", "thread_id");
            payload.put("secondaryId", secondaryId == null ? JSONObject.NULL : secondaryId);
            return payload;
        } catch (Exception ignored) { return null; }
    }

    static String destinationForLegacyType(String destination, String type) {
        if (destination != null) return destination;
        if ("chat_message".equals(type)) return Destination.MESSAGE_THREAD.name();
        if ("incoming_call".equals(type) || "incoming_call_fallback".equals(type)) return Destination.INCOMING_CALL.name();
        if ("call_missed".equals(type)) return Destination.MISSED_CALL.name();
        if ("call_accepted".equals(type) || "call_failed".equals(type) || "call_ended".equals(type) || "call_cancelled".equals(type) || "call_rejected".equals(type)) return Destination.CALL_HISTORY.name();
        if ("follow_request".equals(type)) return Destination.FOLLOW_REQUEST.name();
        if ("follow_accept".equals(type)) return Destination.FOLLOW_ACCEPTED.name();
        if ("apk_update".equals(type)) return Destination.APP_UPDATE.name();
        if ("relationship_followup".equals(type)) return Destination.RELATIONSHIP_FOLLOWUP.name();
        if ("seva_case_update".equals(type)) return Destination.SEVA_CASE.name();
        return null;
    }

    private static Destination canonicalDestination(Destination destination) {
        if (destination == null) return Destination.APP_UPDATE;
        switch (destination) {
            case SOCIAL: return Destination.SOCIAL_ALERT;
            case RELATIONSHIP: return Destination.RELATIONSHIP_FOLLOWUP;
            case SEVA: return Destination.SEVA_CASE;
            default: return destination;
        }
    }

    static boolean requiresEntity(Destination destination) {
        return destination != Destination.APP_UPDATE && destination != Destination.SETTINGS_SECTION && destination != Destination.PAYMENT_RESULT;
    }

    private static String requiredField(Destination destination) {
        switch (destination) {
            case MESSAGE_THREAD: return "thread_id";
            case AI_CONVERSATION: return "chat_id";
            case INCOMING_CALL:
            case MISSED_CALL:
            case CALL_HISTORY: return "call_id";
            case FOLLOW_REQUEST: return "request_id";
            case FOLLOW_ACCEPTED: return "actor_id";
            case SOCIAL_ALERT: return "notification_id";
            case SCREEN_SHARE_SESSION: return "session_id";
            case RELATIONSHIP_FOLLOWUP: return "contact_id";
            case SEVA_CASE: return "case_route_id";
            default: return null;
        }
    }

    private static String first(Intent intent, String first, String second, String third) {
        String value = clean(first == null ? null : intent.getStringExtra(first));
        if (value == null) value = clean(second == null ? null : intent.getStringExtra(second));
        if (value == null) value = clean(third == null ? null : intent.getStringExtra(third));
        return value;
    }

    private static void markConsumed(SharedPreferences prefs, String eventId) {
        Set<String> seen = new HashSet<>(prefs.getStringSet(SEEN, new HashSet<>()));
        if (seen.size() >= MAX_SEEN) seen.clear();
        if (!eventId.isEmpty()) seen.add(eventId);
        prefs.edit().putStringSet(SEEN, seen).remove(PENDING).apply();
    }

    private static String clean(String value) {
        if (value == null) return null;
        String clean = value.trim();
        return clean.isEmpty() || clean.length() > 256 ? null : clean;
    }

    private static long parseLong(String value) {
        try { return Long.parseLong(value == null ? "0" : value); }
        catch (NumberFormatException ignored) { return 0L; }
    }
}
