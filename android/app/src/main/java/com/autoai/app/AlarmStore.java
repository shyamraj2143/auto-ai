package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class AlarmStore {
    private static final String PREFERENCES = "auto_ai_alarms_v1";
    private static final String KEY_ALARMS = "alarms";

    private AlarmStore() {}

    static synchronized List<AlarmPayload> all(Context context) {
        List<AlarmPayload> alarms = new ArrayList<>();
        String raw = preferences(context).getString(KEY_ALARMS, "[]");
        try {
            JSONArray array = new JSONArray(raw == null ? "[]" : raw);
            for (int index = 0; index < array.length(); index++) {
                AlarmPayload payload = AlarmPayload.fromJson(array.optJSONObject(index));
                if (payload != null) alarms.add(payload);
            }
        } catch (Exception ignored) {}
        return alarms;
    }

    static synchronized AlarmPayload get(Context context, String alarmId) {
        for (AlarmPayload payload : all(context)) if (payload.alarmId.equals(alarmId)) return payload;
        return null;
    }

    static synchronized AlarmPayload ringing(Context context) {
        AlarmPayload earliest = null;
        for (AlarmPayload payload : all(context)) {
            if (!payload.enabled || !"ringing".equals(payload.status)) continue;
            if (earliest == null || payload.scheduledAtEpochMs < earliest.scheduledAtEpochMs) earliest = payload;
        }
        return earliest;
    }

    static synchronized boolean upsert(Context context, AlarmPayload incoming) {
        if (incoming == null || !incoming.valid()) return false;
        List<AlarmPayload> alarms = all(context);
        boolean replaced = false;
        for (int index = 0; index < alarms.size(); index++) {
            AlarmPayload existing = alarms.get(index);
            if (!existing.alarmId.equals(incoming.alarmId)) continue;
            if (existing.revision > incoming.revision) return false;
            alarms.set(index, incoming);
            replaced = true;
            break;
        }
        if (!replaced) alarms.add(incoming);
        save(context, alarms);
        return true;
    }

    static synchronized List<String> replaceAll(Context context, List<AlarmPayload> incoming) {
        List<String> removed = new ArrayList<>();
        Set<String> incomingIds = new HashSet<>();
        List<AlarmPayload> existing = all(context);
        List<AlarmPayload> merged = new ArrayList<>();
        for (AlarmPayload alarm : incoming) if (alarm != null && alarm.valid()) incomingIds.add(alarm.alarmId);
        for (AlarmPayload remote : incoming) {
            if (remote == null || !remote.valid()) continue;
            AlarmPayload newest = remote;
            for (AlarmPayload local : existing) {
                boolean preserveActiveRing = local.alarmId.equals(remote.alarmId)
                    && local.revision == remote.revision
                    && "ringing".equals(local.status)
                    && "scheduled".equals(remote.status);
                if (local.alarmId.equals(remote.alarmId) && (local.revision > remote.revision || preserveActiveRing)) {
                    newest = local;
                    break;
                }
            }
            merged.add(newest);
        }
        for (AlarmPayload local : existing) if (!incomingIds.contains(local.alarmId)) removed.add(local.alarmId);
        save(context, merged);
        return removed;
    }

    static synchronized void remove(Context context, String alarmId) {
        List<AlarmPayload> alarms = all(context);
        alarms.removeIf(item -> item.alarmId.equals(alarmId));
        save(context, alarms);
    }

    static synchronized AlarmPayload snooze(Context context, String alarmId, long nextEpochMs) {
        AlarmPayload existing = get(context, alarmId);
        if (existing == null) return null;
        AlarmPayload next = existing.snoozed(nextEpochMs);
        upsert(context, next);
        return next;
    }

    static synchronized AlarmPayload markCompleted(Context context, String alarmId) {
        AlarmPayload existing = get(context, alarmId);
        if (existing == null) return null;
        AlarmPayload completed = existing.withState(false, "completed");
        upsert(context, completed);
        return completed;
    }

    static synchronized void markRinging(Context context, String alarmId) {
        AlarmPayload existing = get(context, alarmId);
        if (existing == null || "ringing".equals(existing.status)) return;
        upsert(context, existing.inherited(new AlarmPayload(existing.alarmId, existing.title, existing.note,
            existing.scheduledAtEpochMs, existing.timezone, existing.language, existing.voiceStyle,
            existing.ringtone, existing.repeat, existing.snoozeMinutes, existing.vibration, existing.assistantMessage, existing.enabled, "ringing", existing.revision)));
    }

    private static void save(Context context, List<AlarmPayload> alarms) {
        JSONArray array = new JSONArray();
        for (AlarmPayload alarm : alarms) if (alarm != null && alarm.valid()) array.put(alarm.toJson());
        preferences(context).edit().putString(KEY_ALARMS, array.toString()).commit();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
