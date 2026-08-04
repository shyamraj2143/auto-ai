package com.autoai.app;

import org.json.JSONObject;

import java.util.Map;
import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;
import java.util.TimeZone;
import java.util.Locale;

final class AlarmPayload {
    final String alarmId;
    final String title;
    final String note;
    final long scheduledAtEpochMs;
    final String timezone;
    final String language;
    final String voiceStyle;
    final String ringtone;
    final String repeat;
    final int snoozeMinutes;
    final boolean vibration;
    final String assistantMessage;
    final boolean enabled;
    final String status;
    final int revision;
    String recurrenceType = "ONCE";
    String endDate = "";
    boolean snoozeEnabled = true;

    AlarmPayload(
        String alarmId,
        String title,
        String note,
        long scheduledAtEpochMs,
        String timezone,
        String language,
        String voiceStyle,
        String ringtone,
        String repeat,
        int snoozeMinutes,
        boolean vibration,
        String assistantMessage,
        boolean enabled,
        String status,
        int revision
    ) {
        this.alarmId = clean(alarmId, "");
        this.title = clean(title, "AutoAI alarm");
        this.note = clean(note, "");
        this.scheduledAtEpochMs = scheduledAtEpochMs;
        this.timezone = clean(timezone, "UTC");
        this.language = allowed(language, new String[] { "hi-IN", "hinglish-IN", "en-IN" }, "hinglish-IN");
        this.voiceStyle = allowed(voiceStyle, new String[] { "warm", "gentle", "energetic" }, "warm");
        this.ringtone = allowed(ringtone, new String[] { "system", "gentle", "energetic" }, "system");
        this.repeat = clean(repeat, "");
        this.snoozeMinutes = Math.max(1, Math.min(120, snoozeMinutes));
        this.vibration = vibration;
        this.assistantMessage = clean(assistantMessage, this.title);
        this.enabled = enabled;
        this.status = clean(status, enabled ? "scheduled" : "paused");
        this.revision = Math.max(1, revision);
    }

    boolean valid() {
        return !alarmId.isEmpty() && scheduledAtEpochMs > 0 && !assistantMessage.isEmpty();
    }

    AlarmPayload snoozed(long nextEpochMs) {
        return inherited(new AlarmPayload(alarmId, title, note, nextEpochMs, timezone, language, voiceStyle,
            ringtone, repeat, snoozeMinutes, vibration, assistantMessage, true, "scheduled", revision + 1));
    }

    AlarmPayload withState(boolean nextEnabled, String nextStatus) {
        return inherited(new AlarmPayload(alarmId, title, note, scheduledAtEpochMs, timezone, language, voiceStyle,
            ringtone, repeat, snoozeMinutes, vibration, assistantMessage, nextEnabled, nextStatus, revision + 1));
    }

    AlarmPayload nextRepeat(long nowEpochMs) {
        Set<Integer> days = new HashSet<>();
        for (String item : repeat.split(",")) try { int day = Integer.parseInt(item.trim()); if (day >= 0 && day <= 6) days.add(day); } catch (Exception ignored) {}
        if (days.isEmpty()) return null;
        TimeZone zone = TimeZone.getTimeZone(timezone);
        Calendar original = Calendar.getInstance(zone); original.setTimeInMillis(scheduledAtEpochMs);
        Calendar candidate = Calendar.getInstance(zone); candidate.setTimeInMillis(nowEpochMs);
        int hour = original.get(Calendar.HOUR_OF_DAY), minute = original.get(Calendar.MINUTE), second = original.get(Calendar.SECOND);
        for (int offset = 1; offset <= 7; offset++) {
            candidate.add(Calendar.DAY_OF_YEAR, 1); candidate.set(Calendar.HOUR_OF_DAY, hour); candidate.set(Calendar.MINUTE, minute); candidate.set(Calendar.SECOND, second); candidate.set(Calendar.MILLISECOND, 0);
            String localDate = String.format(Locale.US, "%04d-%02d-%02d", candidate.get(Calendar.YEAR), candidate.get(Calendar.MONTH) + 1, candidate.get(Calendar.DAY_OF_MONTH));
            if (!endDate.isEmpty() && localDate.compareTo(endDate) > 0) return null;
            int mondayBased = (candidate.get(Calendar.DAY_OF_WEEK) + 5) % 7;
            if (days.contains(mondayBased)) return inherited(new AlarmPayload(alarmId, title, note, candidate.getTimeInMillis(), timezone, language, voiceStyle, ringtone, repeat, snoozeMinutes, vibration, assistantMessage, true, "scheduled", revision + 1));
        }
        return null;
    }

    AlarmPayload inherited(AlarmPayload next) {
        next.recurrenceType = recurrenceType;
        next.endDate = endDate;
        next.snoozeEnabled = snoozeEnabled;
        return next;
    }

    JSONObject toJson() {
        JSONObject out = new JSONObject();
        try {
            out.put("alarmId", alarmId);
            out.put("title", title);
            out.put("note", note);
            out.put("scheduledAtEpochMs", scheduledAtEpochMs);
            out.put("timezone", timezone);
            out.put("language", language);
            out.put("voiceStyle", voiceStyle);
            out.put("ringtone", ringtone);
            out.put("repeat", repeat);
            out.put("snoozeMinutes", snoozeMinutes);
            out.put("vibration", vibration);
            out.put("assistantMessage", assistantMessage);
            out.put("enabled", enabled);
            out.put("status", status);
            out.put("revision", revision);
            out.put("recurrenceType", recurrenceType);
            out.put("endDate", endDate);
            out.put("snoozeEnabled", snoozeEnabled);
        } catch (Exception ignored) {}
        return out;
    }

    static AlarmPayload fromJson(JSONObject value) {
        if (value == null) return null;
        AlarmPayload payload = new AlarmPayload(
            value.optString("alarmId", value.optString("alarm_id", "")),
            value.optString("title", "AutoAI alarm"),
            value.optString("note", ""),
            value.optLong("scheduledAtEpochMs", value.optLong("scheduled_at_epoch_ms", 0L)),
            value.optString("timezone", "UTC"),
            value.optString("language", "hinglish-IN"),
            value.optString("voiceStyle", value.optString("voice_style", "warm")),
            value.optString("ringtone", "system"),
            repeatValue(value),
            value.optInt("snoozeMinutes", value.optInt("snooze_minutes", 10)),
            value.optBoolean("vibration", true),
            value.optString("assistantMessage", value.optString("assistant_message", "")),
            value.optBoolean("enabled", true),
            value.optString("status", "scheduled"),
            value.optInt("revision", 1)
        );
        payload.recurrenceType = value.optString("recurrenceType", value.optString("recurrence_type", payload.repeat.isEmpty() ? "ONCE" : "CUSTOM"));
        payload.endDate = value.optString("endDate", value.optString("end_date", ""));
        payload.snoozeEnabled = value.optBoolean("snoozeEnabled", value.optBoolean("snooze_enabled", true));
        return payload.valid() ? payload : null;
    }

    static AlarmPayload fromData(Map<String, String> data) {
        if (data == null) return null;
        try {
            return fromJson(new JSONObject()
                .put("alarm_id", data.get("alarm_id"))
                .put("title", data.get("title"))
                .put("note", data.get("note"))
                .put("scheduled_at_epoch_ms", parseLong(data.get("scheduled_at_epoch_ms")))
                .put("timezone", data.get("timezone"))
                .put("language", data.get("language"))
                .put("voice_style", data.get("voice_style"))
                .put("ringtone", data.get("ringtone"))
                .put("repeat", data.get("repeat"))
                .put("recurrence_type", data.get("recurrence_type"))
                .put("end_date", data.get("end_date"))
                .put("snooze_enabled", Boolean.parseBoolean(data.get("snooze_enabled")))
                .put("snooze_minutes", parseInt(data.get("snooze_minutes")))
                .put("vibration", Boolean.parseBoolean(data.get("vibration")))
                .put("assistant_message", data.get("assistant_message"))
                .put("enabled", Boolean.parseBoolean(data.get("enabled")))
                .put("status", data.get("status"))
                .put("revision", parseInt(data.get("revision"))));
        } catch (Exception ignored) {
            return null;
        }
    }

    static int requestCode(String alarmId) {
        return 24_000 + Math.abs(clean(alarmId, "alarm").hashCode() % 500_000);
    }

    private static String repeatValue(JSONObject value) {
        Object raw = value.opt("repeat");
        if (raw instanceof org.json.JSONArray) {
            org.json.JSONArray array = (org.json.JSONArray) raw; StringBuilder out = new StringBuilder();
            for (int i = 0; i < array.length(); i++) { if (i > 0) out.append(','); out.append(array.optInt(i, -1)); }
            return out.toString();
        }
        return value.optString("repeat", "");
    }

    private static String clean(String value, String fallback) {
        String clean = value == null ? "" : value.trim();
        return clean.isEmpty() ? fallback : clean;
    }

    private static String allowed(String value, String[] choices, String fallback) {
        String clean = clean(value, fallback);
        for (String choice : choices) if (choice.equals(clean)) return clean;
        return fallback;
    }

    private static long parseLong(String value) {
        try { return Long.parseLong(value == null ? "0" : value); }
        catch (NumberFormatException ignored) { return 0L; }
    }

    private static int parseInt(String value) {
        try { return Integer.parseInt(value == null ? "1" : value); }
        catch (NumberFormatException ignored) { return 1; }
    }
}
