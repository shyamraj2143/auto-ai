package com.autoai.app;

import android.Manifest;
import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "AutoAiAlarm",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public final class AutoAiAlarmPlugin extends Plugin {
    private BroadcastReceiver actionReceiver;

    @Override public void load() {
        actionReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                JSObject payload = new JSObject();
                payload.put("alarmId", intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID));
                payload.put("action", intent.getStringExtra(AlarmActionReceiver.EXTRA_ACTION));
                notifyListeners("alarmAction", payload, true);
            }
        };
        IntentFilter filter = new IntentFilter(AlarmActionReceiver.ACTION_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getContext().registerReceiver(actionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else getContext().registerReceiver(actionReceiver, filter);
    }

    @Override protected void handleOnDestroy() {
        if (actionReceiver != null) {
            try { getContext().unregisterReceiver(actionReceiver); } catch (IllegalArgumentException ignored) {}
        }
        super.handleOnDestroy();
    }

    @PluginMethod public void syncAlarms(PluginCall call) {
        JSArray values = call.getArray("alarms");
        List<AlarmPayload> incoming = new ArrayList<>();
        if (values != null) {
            for (int index = 0; index < values.length(); index++) {
                JSONObject value = values.optJSONObject(index);
                AlarmPayload payload = AlarmPayload.fromJson(value);
                if (payload != null) incoming.add(payload);
            }
        }
        for (String removed : AlarmStore.replaceAll(getContext(), incoming)) AlarmScheduler.cancel(getContext(), removed);
        List<AlarmPayload> effective = AlarmStore.all(getContext());
        int scheduled = 0;
        boolean exact = AlarmScheduler.canScheduleExact(getContext());
        for (AlarmPayload alarm : effective) if (AlarmScheduler.schedule(getContext(), alarm).scheduled) scheduled++;
        JSObject result = new JSObject();
        result.put("scheduled", scheduled);
        result.put("exact", exact);
        call.resolve(result);
    }

    @PluginMethod public void scheduleAlarm(PluginCall call) {
        AlarmPayload payload = AlarmPayload.fromJson(call.getObject("alarm"));
        if (payload == null) { call.reject("A valid alarm is required.", "INVALID_ALARM"); return; }
        AlarmStore.upsert(getContext(), payload);
        AlarmScheduler.Result scheduled = AlarmScheduler.schedule(getContext(), payload);
        JSObject result = new JSObject();
        result.put("scheduled", scheduled.scheduled);
        result.put("exact", scheduled.exact);
        call.resolve(result);
    }

    @PluginMethod public void cancelAlarm(PluginCall call) {
        String alarmId = call.getString("alarmId");
        if (alarmId != null) {
            AlarmScheduler.cancel(getContext(), alarmId);
            AlarmStore.remove(getContext(), alarmId);
        }
        call.resolve();
    }

    @PluginMethod public void getStatus(PluginCall call) { call.resolve(status()); }

    @PluginMethod public void requestAlarmAccess(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsGranted()) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        openExactAlarmAccessIfNeeded();
        call.resolve(status());
    }

    @PermissionCallback private void notificationPermissionCallback(PluginCall call) {
        openExactAlarmAccessIfNeeded();
        call.resolve(status());
    }

    @PluginMethod public void previewVoice(PluginCall call) {
        String message = call.getString("message", "Your AutoAI alarm is ready.");
        String language = call.getString("language", "hinglish-IN");
        String style = call.getString("voiceStyle", "warm");
        final TextToSpeech[] holder = new TextToSpeech[1];
        holder[0] = new TextToSpeech(getContext().getApplicationContext(), result -> {
            TextToSpeech preview = holder[0];
            if (result != TextToSpeech.SUCCESS || preview == null) {
                if (preview != null) preview.shutdown();
                call.reject("Voice preview is unavailable.", "TTS_UNAVAILABLE");
                return;
            }
            AlarmRingingService.configureVoice(preview, language, style);
            preview.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) {}
                @Override public void onDone(String utteranceId) { preview.shutdown(); }
                @Override public void onError(String utteranceId) { preview.shutdown(); }
            });
            int spoken = preview.speak(message, TextToSpeech.QUEUE_FLUSH, null, "alarm_preview");
            if (spoken == TextToSpeech.ERROR) {
                preview.shutdown();
                call.reject("Voice preview is unavailable.", "TTS_UNAVAILABLE");
                return;
            }
            call.resolve();
        });
    }

    private JSObject status() {
        boolean exactRequired = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
        boolean notificationsRequired = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
        boolean exactGranted = AlarmScheduler.canScheduleExact(getContext());
        boolean notificationGranted = notificationsGranted();
        JSObject result = new JSObject();
        result.put("native", true);
        result.put("exactAlarmRequired", exactRequired);
        result.put("exactAlarmGranted", exactGranted);
        result.put("notificationsRequired", notificationsRequired);
        result.put("notificationsGranted", notificationGranted);
        result.put("ready", (!exactRequired || exactGranted) && (!notificationsRequired || notificationGranted));
        return result;
    }

    private boolean notificationsGranted() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getContext().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    private void openExactAlarmAccessIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || AlarmScheduler.canScheduleExact(getContext())) return;
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
        } catch (RuntimeException ignored) {
            getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + getContext().getPackageName())));
        }
    }
}
