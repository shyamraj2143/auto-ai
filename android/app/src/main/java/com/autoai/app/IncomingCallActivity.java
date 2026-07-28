package com.autoai.app;

import android.app.Activity;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONObject;

public class IncomingCallActivity extends Activity {
    private static final String TAG = "AutoAiIncomingCall";
    private final ExecutorService avatarExecutor = Executors.newSingleThreadExecutor();
    private String callId;
    private String actionToken;
    private long expiresAt;
    private long callRevision;
    private String callType;
    private String callerName;
    private TextView statusView;
    private Button rejectButton;
    private Button acceptButton;
    private final AtomicBoolean actionRunning = new AtomicBoolean(false);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "INCOMING_ACTIVITY_CREATED sdk=" + Build.VERSION.SDK_INT + " app_version=" + BuildConfig.VERSION_NAME + " timestamp=" + System.currentTimeMillis());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Intent callIntent = getIntent();
        if (callIntent == null) {
            Log.w(TAG, "Incoming call activity finished: missing intent.");
            finish();
            return;
        }
        callId = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        expiresAt = callIntent.getLongExtra(CallNotificationManager.EXTRA_EXPIRES_AT, 0L);
        actionToken = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_ACTION_TOKEN));
        String callerId = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_ID));
        callerName = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_NAME));
        String callerUsername = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_USERNAME));
        String avatarUrl = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_AVATAR));
        callType = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE));
        callRevision = callIntent.getLongExtra(CallNotificationManager.EXTRA_CALL_REVISION, 0L);
        String initialAction = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_ACTION));
        boolean invalidCallerId = callIntent.hasExtra(CallNotificationManager.EXTRA_CALLER_ID) && callerId == null;
        boolean invalidAction = initialAction != null && !"accept".equals(initialAction) && !"audio_only".equals(initialAction);
        if (callId == null || actionToken == null || invalidCallerId || invalidAction
            || (!"audio".equals(callType) && !"video".equals(callType))
            || expiresAt <= System.currentTimeMillis()) {
            Log.w(TAG, "Incoming call activity rejected invalid payload callId=" + callId);
            CallNotificationManager.cancel(this, callId);
            finish();
            return;
        }
        if (callerName == null) callerName = "Auto-AI user";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(40), dp(24), dp(32));
        root.setBackground(gradient(GradientDrawable.Orientation.TL_BR, Color.rgb(8, 13, 35), Color.rgb(28, 18, 61), Color.rgb(2, 6, 23), 0));

        ImageView avatar = new ImageView(this);
        avatar.setImageResource(R.mipmap.ic_launcher);
        avatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        root.addView(avatar, new LinearLayout.LayoutParams(dp(116), dp(116)));
        loadAvatar(avatarUrl, avatar);

        TextView type = label("Incoming " + ("audio".equals(callType) ? "audio" : "video") + " call", 14, Color.rgb(165, 243, 252));
        LinearLayout.LayoutParams typeParams = new LinearLayout.LayoutParams(-2, -2);
        typeParams.topMargin = dp(24);
        root.addView(type, typeParams);
        TextView name = label(callerName, 26, Color.WHITE);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        root.addView(name);
        if (callerUsername != null) {
            TextView username = label("@" + callerUsername, 15, Color.rgb(148, 163, 184));
            root.addView(username);
        }
        TextView privacy = label("Your email and mobile number remain private.", 12, Color.rgb(203, 213, 225));
        LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(-2, -2);
        privacyParams.topMargin = dp(18);
        root.addView(privacy, privacyParams);
        statusView = label("", 14, Color.rgb(34, 211, 238));
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-2, -2);
        statusParams.topMargin = dp(16);
        root.addView(statusView, statusParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(0, dp(64), 0, 0);
        rejectButton = actionButton("Reject", Color.rgb(220, 38, 38), Color.rgb(127, 29, 29));
        acceptButton = actionButton("Accept", Color.rgb(34, 211, 238), Color.rgb(37, 99, 235));
        actions.addView(rejectButton, actionParams());
        actions.addView(acceptButton, actionParams());
        root.addView(actions, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root);

        rejectButton.setOnClickListener(view -> rejectCall());
        acceptButton.setOnClickListener(view -> acceptCall(false));
        if ("accept".equals(initialAction)) acceptCall(false);
        else if ("audio_only".equals(initialAction)) acceptCall(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (expiresAt > 0 && expiresAt <= System.currentTimeMillis()) {
            CallNotificationManager.cancel(this, callId);
            finish();
        }
    }

    @Override
    protected void onDestroy() {
        avatarExecutor.shutdownNow();
        super.onDestroy();
    }

    private void acceptCall(boolean audioOnly) {
        if (!actionRunning.compareAndSet(false, true)) return;
        Log.i(TAG, "ACCEPT_TAPPED callId=" + callId + " audioOnly=" + audioOnly);
        setActionsEnabled(false);
        setStatus("Connecting\u2026", Color.rgb(34, 211, 238));
        String action = audioOnly ? "audio_only" : "accept";
        avatarExecutor.execute(() -> {
            boolean ownsAccept = AcceptedCallHandoffStore.beginAccept(this, callId, callType, callerName, actionToken, expiresAt, callRevision);
            long acceptedRevision = ownsAccept ? sendAccept() : AcceptedCallHandoffStore.revision(this);
            if (acceptedRevision < 0) {
                runOnUiThread(() -> {
                    setStatus("Unable to accept this call.", Color.rgb(239, 68, 68));
                    reportFailure("BACKEND_ACCEPT_FAILED");
                    terminalCleanup();
                });
                return;
            }
            AcceptedCallHandoffStore.commit(this, callId, acceptedRevision);
            Log.i(TAG, "ACTIVE_CALL_HANDOFF_SAVED callId=" + callId + " revision=" + acceptedRevision);
            CallNotificationManager.savePending(this, callId, "resume_call", expiresAt);
            CallNotificationManager.cancelIncomingPresentation(this, callId);
            Log.i(TAG, "ACCEPT_COMMITTED callId=" + callId);
            runOnUiThread(this::startActiveService);
        });
    }

    private long sendAccept() {
        String accessToken = AutoAiSecureStoragePlugin.readStoredValue(this, "auto-ai-access-token");
        if (accessToken == null || accessToken.trim().isEmpty()) return -1L;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "") + "/calls/" + callId + "/accept").openConnection();
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(15000);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);
            JSONObject body = new JSONObject();
            body.put("action_token", actionToken);
            body.put("device_id", PushTokenRegistrar.deviceId(this, "auto_ai_call_device", "fallback_device_id"));
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            Log.i(TAG, "Native accept completed callId=" + callId + " status=" + status);
            if (status < 200 || status >= 300) return -1L;
            try (InputStream input = connection.getInputStream()) {
                byte[] bodyBytes = new byte[8192];
                int read = input.read(bodyBytes);
                if (read > 0) return new JSONObject(new String(bodyBytes, 0, read, StandardCharsets.UTF_8)).optLong("revision", callRevision);
            }
            return callRevision;
        } catch (Exception error) {
            Log.w(TAG, "Native accept failed callId=" + callId, error);
            return -1L;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void startActiveService() {
        AcceptedCallHandoffStore.setState(this, callId, AcceptedCallHandoffStore.State.SERVICE_STARTING);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent result) {
                if (!callId.equals(result.getStringExtra(CallNotificationManager.EXTRA_CALL_ID))) return;
                try { unregisterReceiver(this); } catch (IllegalArgumentException ignored) {}
                if (CallForegroundService.SERVICE_READY.equals(result.getStringExtra(CallForegroundService.EXTRA_SERVICE_STATUS))) {
                    openCallScreen();
                } else {
                    serviceFailure(result.getStringExtra(CallForegroundService.EXTRA_ERROR_CODE));
                }
            }
        };
        IntentFilter filter = new IntentFilter(CallForegroundService.ACTION_SERVICE_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(receiver, filter);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try { unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) { return; }
            serviceFailure("FOREGROUND_SERVICE_TIMEOUT");
        }, 9000L);
        Intent service = new Intent(this, CallForegroundService.class).setAction(CallForegroundService.ACTION_START)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId)
            .putExtra(CallNotificationManager.EXTRA_CALLER_NAME, callerName)
            .putExtra(CallNotificationManager.EXTRA_CALL_TYPE, callType);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service); else startService(service);
            Log.i(TAG, "SERVICE_START_REQUESTED callId=" + callId);
        } catch (RuntimeException error) {
            try { unregisterReceiver(receiver); } catch (IllegalArgumentException ignored) {}
            serviceFailure("FOREGROUND_SERVICE_START_NOT_ALLOWED");
        }
    }

    private void openCallScreen() {
        AcceptedCallHandoffStore.setState(this, callId, AcceptedCallHandoffStore.State.UI_LAUNCHING);
        BroadcastReceiver ready = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (!callId.equals(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID))) return;
                try { unregisterReceiver(this); } catch (IllegalArgumentException ignored) {}
                finish();
            }
        };
        IntentFilter filter = new IntentFilter(AutoAiCallsPlugin.ACTION_UI_READY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(ready, filter, Context.RECEIVER_NOT_EXPORTED); else registerReceiver(ready, filter);
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_ACTION, "resume_call");
        intent.putExtra(CallNotificationManager.EXTRA_CALL_TYPE, callType);
        startActivity(intent);
        Log.i(TAG, "ACTIVE_CALL_UI_LAUNCHED callId=" + callId);
    }

    private void serviceFailure(String code) {
        setStatus("Unable to start the call. Please try again.", Color.rgb(239, 68, 68));
        reportFailure(code == null ? "FOREGROUND_SERVICE_INTERNAL_ERROR" : code);
        terminalCleanup();
    }

    private void reportFailure(String code) {
        avatarExecutor.execute(() -> {
            String accessToken = AutoAiSecureStoragePlugin.readStoredValue(this, "auto-ai-access-token");
            if (accessToken == null) return;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(BuildConfig.AUTO_AI_API_BASE_URL.replaceAll("/+$", "") + "/calls/" + callId + "/fail").openConnection();
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Authorization", "Bearer " + accessToken.trim());
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                JSONObject body = new JSONObject().put("failure_code", code).put("source_device", PushTokenRegistrar.deviceId(this, "auto_ai_call_device", "fallback_device_id"));
                try (OutputStream output = connection.getOutputStream()) { output.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                connection.getResponseCode();
            } catch (Exception error) { Log.w(TAG, "Unable to report native call failure callId=" + callId, error); }
            finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void terminalCleanup() {
        CallNotificationManager.cancelAllForTerminalCall(this, callId);
        Intent stop = new Intent(this, CallForegroundService.class).setAction(CallForegroundService.ACTION_STOP)
            .putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        try { startService(stop); } catch (RuntimeException ignored) {}
    }

    private void setStatus(String text, int color) {
        if (statusView != null) { statusView.setText(text); statusView.setTextColor(color); }
    }

    private void setActionsEnabled(boolean enabled) {
        if (acceptButton != null) acceptButton.setEnabled(enabled);
        if (rejectButton != null) rejectButton.setEnabled(enabled);
    }

    private void rejectCall() {
        Intent intent = new Intent(this, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_REJECT);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_ACTION_TOKEN, actionToken);
        Log.i(TAG, "Incoming call rejected callId=" + callId);
        sendBroadcast(intent);
        finish();
    }

    private void loadAvatar(String avatarUrl, ImageView view) {
        if (avatarUrl == null || !avatarUrl.startsWith("https://")) return;
        avatarExecutor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(avatarUrl).openConnection();
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(5000);
                connection.setInstanceFollowRedirects(false);
                if (connection.getResponseCode() != 200 || connection.getContentLengthLong() > 2_000_000L) return;
                try (InputStream input = connection.getInputStream()) {
                    Bitmap bitmap = BitmapFactory.decodeStream(input);
                    if (bitmap != null) runOnUiThread(() -> view.setImageBitmap(bitmap));
                }
            } catch (Exception ignored) {
                // The app icon remains visible when the remote avatar cannot be loaded safely.
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private Button actionButton(String text, int startColor, int endColor) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setTextSize(13);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setBackground(gradient(GradientDrawable.Orientation.LEFT_RIGHT, startColor, endColor, endColor, dp(18)));
        button.setMinWidth(dp(112));
        button.setMinHeight(dp(54));
        return button;
    }

    private LinearLayout.LayoutParams actionParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(58), 1f);
        params.setMargins(dp(8), 0, dp(8), 0);
        return params;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable gradient(GradientDrawable.Orientation orientation, int startColor, int centerColor, int endColor, int radius) {
        GradientDrawable drawable = new GradientDrawable(orientation, new int[] {startColor, centerColor, endColor});
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private String clean(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        return value.trim();
    }
}
