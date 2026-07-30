package com.autoai.app;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Log;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.Chronometer;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.webrtc.SurfaceViewRenderer;

/** Native, lock-screen-safe active call UI with no private app content. */
public class ActiveCallActivity extends Activity implements NativeCallSessionController.Listener {
    private static final String TAG = "AutoAiActiveCall";
    private String callId;
    private String callType;
    private NativeCallSessionController controller;
    private TextView status;
    private Chronometer chronometer;
    private Button mute;
    private Button speaker;
    private Button camera;
    private Button flipCamera;
    private Button minimize;
    private SurfaceViewRenderer localVideo;
    private SurfaceViewRenderer remoteVideo;
    private PowerManager.WakeLock proximityLock;
    private boolean speakerEnabled;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_SECURE);
        readIntent(getIntent());
        if (callId == null) { finish(); return; }
        ActiveCallStore.Snapshot stored = ActiveCallStore.get(this, callId);
        if (stored == null || !stored.isUsable()) {
            CallIntentDispatcher.dispatchMainFallback(this, getIntent());
            finish();
            return;
        }
        callType = stored.callType;
        buildUi(stored);
        controller = NativeCallSessionController.get(this);
        controller.addListener(this);
        if (!controller.owns(callId)) controller.start(callId, callType, stored.peerName);
        if ("video".equals(callType)) controller.attachRenderers(localVideo, remoteVideo);
        ActiveCallStore.update(this, callId, ActiveCallStore.State.ACTIVE_UI_READY);
        sendBroadcast(new Intent(CallIntentDispatcher.ACTION_UI_READY).setPackage(getPackageName())
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId));
        Log.i(TAG, "ACTIVE_UI_READY callId=" + callId + " DEVICE_LOCKED=" + keyguardLocked()
            + " KEYGUARD_DISMISSED=false ACTIVE_CALL_UI_VISIBLE=true");
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); readIntent(intent); }

    @Override protected void onResume() {
        super.onResume();
        if ("audio".equals(callType)) acquireProximityLock();
    }

    @Override protected void onPause() {
        releaseProximityLock();
        super.onPause();
    }

    @Override protected void onDestroy() {
        releaseProximityLock();
        if (controller != null) { controller.removeListener(this); controller.detachRenderers(); }
        super.onDestroy();
    }

    @Override public void onState(ActiveCallStore.State state, String errorCode) {
        runOnUiThread(() -> {
            if (status == null) return;
            switch (state) {
                case SERVICE_READY: setStatus("Preparing secure call…", 0xFF22D3EE); break;
                case SIGNALING_CONNECTING: setStatus("Connecting signaling…", 0xFF22D3EE); break;
                case SIGNALING_CONNECTED: setStatus("Connecting media…", 0xFF22D3EE); break;
                case MEDIA_CONNECTING: setStatus("Connecting call…", 0xFF22D3EE); break;
                case MEDIA_CONNECTED:
                    setStatus("Connected", 0xFF22C55E);
                    chronometer.setBase(android.os.SystemClock.elapsedRealtime());
                    chronometer.setVisibility(View.VISIBLE);
                    chronometer.start();
                    Log.i(TAG, "AUDIO_SESSION_ACTIVE=true callId=" + callId);
                    break;
                case RECONNECTING: setStatus("Reconnecting…", 0xFFF59E0B); break;
                case TERMINAL:
                    setStatus(errorCode == null ? "Call ended" : readableFailure(errorCode), errorCode == null ? 0xFF94A3B8 : 0xFFEF4444);
                    chronometer.stop();
                    status.postDelayed(this::finishAndRemoveTask, 900L);
                    break;
                default: setStatus("Connecting call…", 0xFF22D3EE);
            }
        });
    }

    @Override public void onRemoteVideoAvailable() { runOnUiThread(() -> remoteVideo.setVisibility(View.VISIBLE)); }

    @Override public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && "video".equals(callType) && !isFinishing()) {
            try { enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(9, 16)).build()); }
            catch (RuntimeException ignored) {}
        }
    }

    private void buildUi(ActiveCallStore.Snapshot call) {
        FrameLayout root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(
            GradientDrawable.Orientation.TL_BR,
            new int[] {0xFF020617, 0xFF1E1B4B, 0xFF082F49, 0xFF020617}
        ));
        if ("video".equals(callType)) {
            remoteVideo = new SurfaceViewRenderer(this);
            remoteVideo.setVisibility(View.INVISIBLE);
            root.addView(remoteVideo, new FrameLayout.LayoutParams(-1, -1));
            localVideo = new SurfaceViewRenderer(this);
            FrameLayout.LayoutParams localParams = new FrameLayout.LayoutParams(dp(112), dp(160), Gravity.END | Gravity.TOP);
            localParams.setMargins(dp(12), dp(40), dp(12), 0);
            root.addView(localVideo, localParams);
        }
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(20), dp(48), dp(20), dp(28));
        TextView privacy = text("Secure Auto-AI " + call.callType + " call", 13, 0xFF94A3B8);
        panel.addView(privacy);
        if ("audio".equals(callType)) {
            TextView avatar = text(initial(call.peerName), 42, Color.WHITE);
            avatar.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            GradientDrawable avatarBackground = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[] {0xFF312E81, 0xFF0E7490}
            );
            avatarBackground.setShape(GradientDrawable.OVAL);
            avatar.setBackground(avatarBackground);
            LinearLayout.LayoutParams avatarParams = new LinearLayout.LayoutParams(dp(112), dp(112));
            avatarParams.topMargin = dp(22);
            panel.addView(avatar, avatarParams);
        }
        TextView name = text(call.peerName, 26, Color.WHITE);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-2, -2); nameParams.topMargin = dp(14);
        panel.addView(name, nameParams);
        status = text("Connecting call…", 16, 0xFF22D3EE);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-2, -2); statusParams.topMargin = dp(12);
        panel.addView(status, statusParams);
        chronometer = new Chronometer(this); chronometer.setTextColor(Color.WHITE); chronometer.setTextSize(18); chronometer.setVisibility(View.GONE);
        panel.addView(chronometer);
        LinearLayout controls = new LinearLayout(this); controls.setGravity(Gravity.CENTER); controls.setPadding(0, dp(36), 0, 0);
        mute = control("Mute", android.R.drawable.ic_lock_silent_mode);
        speaker = control("Speaker", android.R.drawable.ic_lock_silent_mode_off);
        controls.addView(mute, controlParams()); controls.addView(speaker, controlParams());
        if ("video".equals(callType)) {
            camera = control("Camera", android.R.drawable.ic_menu_camera);
            flipCamera = control("Flip", android.R.drawable.ic_menu_rotate);
            controls.addView(camera, controlParams());
            controls.addView(flipCamera, controlParams());
        }
        minimize = control("Minimize", android.R.drawable.ic_menu_view);
        controls.addView(minimize, controlParams());
        panel.addView(controls, new LinearLayout.LayoutParams(-1, -2));
        Button end = control("End call", android.R.drawable.ic_menu_close_clear_cancel); end.setTextColor(0xFFFFE4E6); end.setBackgroundColor(0xFF991B1B);
        LinearLayout.LayoutParams endParams = new LinearLayout.LayoutParams(dp(180), dp(56)); endParams.topMargin = dp(24);
        panel.addView(end, endParams);
        root.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);

        mute.setOnClickListener(view -> guarded(mute, () -> { boolean value = !controller.isMuted(); controller.setMuted(value); mute.setText(value ? "Unmute" : "Mute"); }));
        speaker.setOnClickListener(view -> guarded(speaker, this::toggleSpeaker));
        if (camera != null) camera.setOnClickListener(view -> guarded(camera, () -> { boolean value = !controller.isCameraEnabled(); controller.setCameraEnabled(value); camera.setText(value ? "Camera" : "Camera off"); }));
        if (flipCamera != null) flipCamera.setOnClickListener(view -> guarded(flipCamera, controller::switchCamera));
        minimize.setOnClickListener(view -> guarded(minimize, this::minimizeCall));
        end.setOnClickListener(view -> { end.setEnabled(false); controller.end("user_hangup"); });
    }

    private void toggleSpeaker() {
        speakerEnabled = !speakerEnabled;
        AudioManager manager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (manager != null) { manager.setMode(AudioManager.MODE_IN_COMMUNICATION); manager.setSpeakerphoneOn(speakerEnabled); }
        speaker.setText(speakerEnabled ? "Earpiece" : "Speaker");
    }

    private void minimizeCall() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && "video".equals(callType)) {
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(new Rational(9, 16)).build());
        } else {
            moveTaskToBack(true);
        }
    }

    private void guarded(Button button, Runnable action) {
        if (!button.isEnabled()) return;
        button.setEnabled(false);
        action.run();
        button.postDelayed(() -> button.setEnabled(true), 350L);
    }

    private void readIntent(Intent intent) {
        callId = intent == null ? null : clean(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        callType = intent == null ? "audio" : intent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE);
    }

    private void acquireProximityLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null || !manager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return;
        if (proximityLock == null) proximityLock = manager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "autoai:active-call-proximity");
        if (!proximityLock.isHeld()) proximityLock.acquire();
    }

    private void releaseProximityLock() { if (proximityLock != null && proximityLock.isHeld()) proximityLock.release(); }
    private boolean keyguardLocked() { android.app.KeyguardManager manager = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE); return manager != null && manager.isKeyguardLocked(); }
    private void setStatus(String value, int color) { status.setText(value); status.setTextColor(color); }
    private TextView text(String value, int size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setGravity(Gravity.CENTER); return view; }
    private Button control(String value, int icon) { Button button = new Button(this); button.setText(value); button.setTextColor(Color.WHITE); button.setTextSize(10); button.setCompoundDrawablesWithIntrinsicBounds(0, icon, 0, 0); button.setCompoundDrawablePadding(dp(3)); button.setBackgroundColor(0xCC0F172A); return button; }
    private LinearLayout.LayoutParams controlParams() { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(54), 1f); params.setMargins(dp(4), 0, dp(4), 0); return params; }
    private String readableFailure(String code) { return "AutoAI could not prepare the call. Please retry."; }
    private String initial(String name) { return name == null || name.trim().isEmpty() ? "A" : name.trim().substring(0, 1).toUpperCase(java.util.Locale.US); }
    private String clean(String value) { return value == null || value.trim().isEmpty() ? null : value.trim(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
