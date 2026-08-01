package com.autoai.app;

import org.json.JSONObject;

import java.util.Map;

final class AlarmPayload {
    final String alarmId;
    final String title;
    final String note;
    final long scheduledAtEpochMs;
    final String timezone;
    final String language;
    final String voiceStyle;
    final String ringtone;
    final String assistantMessage;
    final boolean enabled;
    final String status;
    final int revision;

    AlarmPayload(
        String alarmId,
        String title,
        String note,
        long scheduledAtEpochMs,
        String timezone,
        String language,
        String voiceStyle,
        String ringtone,
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
        this.assistantMessage = clean(assistantMessage, this.title);
        this.enabled = enabled;
        this.status = clean(status, enabled ? "scheduled" : "paused");
        this.revision = Math.max(1, revision);
    }

    boolean valid() {
        return !alarmId.isEmpty() && scheduledAtEpochMs > 0 && !assistantMessage.isEmpty();
    }

    AlarmPayload snoozed(long nextEpochMs) {
        return new AlarmPayload(alarmId, title, note, nextEpochMs, timezone, language, voiceStyle,
            ringtone, assistantMessage, true, "scheduled", revision + 1);
    }

    AlarmPayload withState(boolean nextEnabled, String nextStatus) {
        return new AlarmPayload(alarmId, title, note, scheduledAtEpochMs, timezone, language, voiceStyle,
            ringtone, assistantMessage, nextEnabled, nextStatus, revision + 1);
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
            out.put("assistantMessage", assistantMessage);
            out.put("enabled", enabled);
            out.put("status", status);
            out.put("revision", revision);
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
            value.optString("assistantMessage", value.optString("assistant_message", "")),
            value.optBoolean("enabled", true),
            value.optString("status", "scheduled"),
            value.optInt("revision", 1)
        );
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
