package com.autoai.app;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.telecom.Connection;
import android.telecom.DisconnectCause;
import android.telecom.TelecomManager;
import android.telecom.VideoProfile;
import android.util.Log;

public class AutoAiCallConnection extends Connection {
    private static final String TAG = "AutoAiConnection";

    private final Context context;
    private final String callId;
    private final long expiresAt;
    private final boolean incoming;
    private boolean completed;
    private boolean answered;

    AutoAiCallConnection(Context context, String callId, String displayName, String callType, long expiresAt, boolean incoming) {
        this.context = context.getApplicationContext();
        this.callId = callId == null ? "" : callId.trim();
        this.expiresAt = expiresAt;
        this.incoming = incoming;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) setConnectionProperties(PROPERTY_SELF_MANAGED);
        setAudioModeIsVoip(true);
        setAddress(Uri.fromParts("autoai", this.callId.isEmpty() ? "call" : this.callId, null), TelecomManager.PRESENTATION_ALLOWED);
        setCallerDisplayName(displayName == null || displayName.trim().isEmpty() ? "Auto-AI call" : displayName.trim(), TelecomManager.PRESENTATION_ALLOWED);
        setVideoState("video".equals(callType) ? VideoProfile.STATE_BIDIRECTIONAL : VideoProfile.STATE_AUDIO_ONLY);
    }

    String callId() {
        return callId;
    }

    void markActiveFromApp() {
        if (completed) return;
        answered = true;
        Log.i(TAG, "Telecom connection marked active callId=" + callId);
        setActive();
    }

    void disconnectLocal() {
        if (completed) return;
        completed = true;
        setDisconnected(new DisconnectCause(DisconnectCause.LOCAL));
        destroy();
        AutoAiTelecomBridge.unregister(callId, this);
    }

    @Override
    public void onAnswer() {
        if (completed) return;
        answered = true;
        Log.i(TAG, "Telecom answer callId=" + callId);
        setActive();
        AutoAiTelecomBridge.acceptFromTelecom(context, callId, expiresAt);
    }

    @Override
    public void onAnswer(int videoState) {
        onAnswer();
    }

    @Override
    public void onReject() {
        if (completed) return;
        completed = true;
        Log.i(TAG, "Telecom reject callId=" + callId);
        setDisconnected(new DisconnectCause(DisconnectCause.REJECTED));
        AutoAiTelecomBridge.rejectFromTelecom(context, callId);
        destroy();
        AutoAiTelecomBridge.unregister(callId, this);
    }

    @Override
    public void onDisconnect() {
        if (completed) return;
        completed = true;
        Log.i(TAG, "Telecom disconnect callId=" + callId + " incoming=" + incoming);
        setDisconnected(new DisconnectCause(DisconnectCause.LOCAL));
        if (incoming && !answered) AutoAiTelecomBridge.rejectFromTelecom(context, callId);
        else AutoAiTelecomBridge.endFromTelecom(context, callId);
        destroy();
        AutoAiTelecomBridge.unregister(callId, this);
    }

    @Override
    public void onAbort() {
        disconnectLocal();
    }
}
