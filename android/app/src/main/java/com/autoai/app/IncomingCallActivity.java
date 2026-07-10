package com.autoai.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
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

public class IncomingCallActivity extends Activity {
    private final ExecutorService avatarExecutor = Executors.newSingleThreadExecutor();
    private String callId;
    private long expiresAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        Intent callIntent = getIntent();
        if (callIntent == null) {
            finish();
            return;
        }
        callId = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALL_ID));
        expiresAt = callIntent.getLongExtra(CallNotificationManager.EXTRA_EXPIRES_AT, 0L);
        String callerId = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_ID));
        String callerName = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_NAME));
        String callerUsername = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_USERNAME));
        String avatarUrl = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALLER_AVATAR));
        String callType = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_CALL_TYPE));
        String initialAction = clean(callIntent.getStringExtra(CallNotificationManager.EXTRA_ACTION));
        boolean invalidCallerId = callIntent.hasExtra(CallNotificationManager.EXTRA_CALLER_ID) && callerId == null;
        boolean invalidAction = initialAction != null && !"accept".equals(initialAction);
        if (callId == null || invalidCallerId || invalidAction
            || (!"audio".equals(callType) && !"video".equals(callType))
            || expiresAt <= System.currentTimeMillis()) {
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

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER);
        actions.setPadding(0, dp(64), 0, 0);
        Button reject = actionButton("Reject", Color.rgb(220, 38, 38), Color.rgb(127, 29, 29));
        Button accept = actionButton("Accept", Color.rgb(34, 211, 238), Color.rgb(37, 99, 235));
        actions.addView(reject, actionParams());
        actions.addView(accept, actionParams());
        root.addView(actions, new LinearLayout.LayoutParams(-1, -2));
        setContentView(root);

        reject.setOnClickListener(view -> rejectCall());
        accept.setOnClickListener(view -> acceptCall());
        if ("accept".equals(initialAction)) acceptCall();
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

    private void acceptCall() {
        CallNotificationManager.savePending(this, callId, "accept", expiresAt);
        CallNotificationManager.cancelNotification(this, callId);
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
        intent.putExtra(CallNotificationManager.EXTRA_ACTION, "accept");
        startActivity(intent);
        finish();
    }

    private void rejectCall() {
        Intent intent = new Intent(this, CallActionReceiver.class).setAction(CallNotificationManager.ACTION_REJECT);
        intent.putExtra(CallNotificationManager.EXTRA_CALL_ID, callId);
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
