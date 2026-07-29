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
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

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
    private Button audioOnlyButton;
    private final AtomicBoolean actionRunning = new AtomicBoolean(false);
    private BroadcastReceiver activeUiReadyReceiver;

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
        activeUiReadyReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (callId.equals(intent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID))) finish();
            }
        };
        IntentFilter readyFilter = new IntentFilter(CallIntentDispatcher.ACTION_UI_READY);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(activeUiReadyReceiver, readyFilter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(activeUiReadyReceiver, readyFilter);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(24), dp(40), dp(24), dp(32));
        root.setBackground(gradient(GradientDrawable.Orientation.TL_BR, Color.rgb(8, 13, 35), Color.rgb(28, 18, 61), Color.rgb(2, 6, 23), 0));

        ImageView avatar = new ImageView(this);
        avatar.setImageBitmap(initialAvatar(callerName));
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
        if ("video".equals(callType)) {
            audioOnlyButton = actionButton("Answer audio only", Color.rgb(14, 116, 144), Color.rgb(30, 64, 175));
            LinearLayout.LayoutParams audioOnlyParams = new LinearLayout.LayoutParams(-1, dp(52));
            audioOnlyParams.setMargins(dp(8), dp(12), dp(8), 0);
            root.addView(audioOnlyButton, audioOnlyParams);
            audioOnlyButton.setOnClickListener(view -> acceptCall(true));
        }
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
        if (activeUiReadyReceiver != null) try { unregisterReceiver(activeUiReadyReceiver); } catch (IllegalArgumentException ignored) {}
        avatarExecutor.shutdownNow();
        super.onDestroy();
    }

    private void acceptCall(boolean audioOnly) {
        if (!actionRunning.compareAndSet(false, true)) return;
        Log.i(TAG, "ACCEPT_TAPPED callId=" + callId + " audioOnly=" + audioOnly);
        setActionsEnabled(false);
        setStatus("Connecting call…", Color.rgb(34, 211, 238));
        CallAcceptCoordinator.accept(this, callId, audioOnly, new CallAcceptCoordinator.Listener() {
            @Override public void onAcceptCommitted() { runOnUiThread(() -> setStatus("Preparing secure call…", Color.rgb(34, 211, 238))); }
            @Override public void onServiceStarting() { runOnUiThread(() -> setStatus("Starting call service…", Color.rgb(34, 211, 238))); }
            @Override public void onServiceReady() { runOnUiThread(() -> setStatus("Opening call…", Color.rgb(34, 211, 238))); }
            @Override public void onFailure(String code) {
                runOnUiThread(() -> {
                    setStatus("Calling service could not start\nAutoAI could not prepare the call. Please retry.", Color.rgb(239, 68, 68));
                    acceptButton.setText("Retry");
                    setActionsEnabled(true);
                    actionRunning.set(false);
                });
            }
        });
    }

    private void setStatus(String text, int color) {
        if (statusView != null) { statusView.setText(text); statusView.setTextColor(color); }
    }

    private void setActionsEnabled(boolean enabled) {
        if (acceptButton != null) acceptButton.setEnabled(enabled);
        if (rejectButton != null) rejectButton.setEnabled(enabled);
        if (audioOnlyButton != null) audioOnlyButton.setEnabled(enabled);
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

    private Bitmap initialAvatar(String name) {
        int size = dp(116);
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
        android.graphics.Paint background = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        background.setColor(Color.rgb(49, 46, 129));
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, background);
        android.graphics.Paint letter = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        letter.setColor(Color.WHITE);
        letter.setTextAlign(android.graphics.Paint.Align.CENTER);
        letter.setTypeface(Typeface.DEFAULT_BOLD);
        letter.setTextSize(size * 0.42f);
        String initial = name == null || name.trim().isEmpty() ? "A" : name.trim().substring(0, 1).toUpperCase(java.util.Locale.US);
        android.graphics.Paint.FontMetrics metrics = letter.getFontMetrics();
        canvas.drawText(initial, size / 2f, size / 2f - (metrics.ascent + metrics.descent) / 2f, letter);
        return bitmap;
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
