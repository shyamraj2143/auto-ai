package com.autoai.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class AlarmRingingActivity extends Activity {
    private String alarmId;
    private BroadcastReceiver changedReceiver;
    private TextView timeView;
    private final Handler clockHandler = new Handler(Looper.getMainLooper());
    private final SimpleDateFormat clockFormat = new SimpleDateFormat("HH:mm:ss", Locale.getDefault());
    private final Runnable clockTick = new Runnable() {
        @Override public void run() {
            if (timeView == null) return;
            long now = System.currentTimeMillis();
            timeView.setText(clockFormat.format(new Date(now)));
            clockHandler.postDelayed(this, Math.max(120L, 1_000L - now % 1_000L));
        }
    };

    static PendingIntent pendingIntent(Context context, AlarmPayload alarm) {
        Intent intent = new Intent(context, AlarmRingingActivity.class)
            .setAction("com.autoai.app.alarm.SHOW")
            .setData(Uri.parse("autoai://alarm-screen/" + Uri.encode(alarm.alarmId)))
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.alarmId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, AlarmPayload.requestCode(alarm.alarmId) + 3, intent, flags);
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(4, 11, 24));
        getWindow().setNavigationBarColor(Color.rgb(4, 11, 24));
        alarmId = getIntent().getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        AlarmPayload alarm = AlarmStore.get(this, alarmId);
        if (alarm == null) { finish(); return; }
        setContentView(content(alarm));
        startClock();
        changedReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                if (alarmId != null && alarmId.equals(intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID))) finishAndRemoveTask();
            }
        };
        IntentFilter filter = new IntentFilter(AlarmActionReceiver.ACTION_CHANGED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) registerReceiver(changedReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(changedReceiver, filter);
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        AlarmPayload alarm = AlarmStore.get(this, alarmId);
        if (alarm == null) {
            finishAndRemoveTask();
            return;
        }
        setContentView(content(alarm));
        startClock();
    }

    private View content(AlarmPayload alarm) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(24), dp(32), dp(24), dp(28));
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
            new int[] { Color.rgb(35, 24, 33), Color.rgb(6, 18, 40), Color.rgb(2, 9, 20) }));

        TextView brand = text("AUTOAI PERSONAL ASSISTANT", 12, Color.rgb(255, 184, 101), Typeface.BOLD);
        brand.setLetterSpacing(.12f);
        root.addView(brand, matchWrap(dp(12)));

        TextView icon = text("⏰", 54, Color.WHITE, Typeface.NORMAL);
        icon.setGravity(Gravity.CENTER);
        icon.setBackground(circle(Color.rgb(221, 92, 34), Color.rgb(255, 181, 91), 1));
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(112), dp(112));
        iconParams.gravity = Gravity.CENTER_HORIZONTAL;
        iconParams.topMargin = dp(22);
        root.addView(icon, iconParams);

        TextView clockLabel = text("LIVE CLOCK • 24-HOUR FORMAT", 10, Color.rgb(137, 159, 188), Typeface.BOLD);
        clockLabel.setGravity(Gravity.CENTER);
        clockLabel.setLetterSpacing(.08f);
        root.addView(clockLabel, matchWrap(dp(22)));

        timeView = text(clockFormat.format(new Date()), 48, Color.WHITE, Typeface.BOLD);
        timeView.setGravity(Gravity.CENTER);
        root.addView(timeView, matchWrap(dp(6)));

        TextView title = text(alarm.title, 24, Color.WHITE, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        title.setMaxLines(3);
        root.addView(title, matchWrap(dp(8)));

        TextView message = text(alarm.assistantMessage, 17, Color.rgb(226, 233, 244), Typeface.NORMAL);
        message.setGravity(Gravity.CENTER);
        message.setLineSpacing(0f, 1.28f);
        message.setPadding(dp(18), dp(18), dp(18), dp(18));
        message.setBackground(rounded(Color.argb(92, 255, 255, 255), Color.argb(58, 255, 185, 102), 18, 1));
        root.addView(message, matchWrap(dp(24)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        Button snooze = actionButton("Snooze 10 min", Color.rgb(27, 43, 68), Color.rgb(128, 157, 202));
        Button dismiss = actionButton("Stop alarm", Color.rgb(222, 91, 35), Color.rgb(255, 184, 102));
        snooze.setOnClickListener(view -> act(AlarmActionReceiver.ACTION_SNOOZE));
        dismiss.setOnClickListener(view -> openAwakeVerification());
        LinearLayout.LayoutParams button = new LinearLayout.LayoutParams(0, dp(54), 1f);
        button.setMargins(dp(4), 0, dp(4), 0);
        actions.addView(snooze, button);
        actions.addView(dismiss, button);
        root.addView(actions, matchWrap(dp(25)));

        TextView helper = text("Stopping requires a live face capture. The alarm keeps ringing until you verify that you are awake.", 11, Color.rgb(128, 146, 171), Typeface.NORMAL);
        helper.setGravity(Gravity.CENTER);
        root.addView(helper, matchWrap(dp(16)));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -1));
        return scroll;
    }

    private void startClock() {
        clockHandler.removeCallbacks(clockTick);
        clockTick.run();
    }

    private void act(String action) {
        sendBroadcast(new Intent(this, AlarmActionReceiver.class).setAction(action)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId));
        finishAndRemoveTask();
    }

    private void openAwakeVerification() {
        startActivity(new Intent(this, AlarmAwakeVerificationActivity.class)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId));
    }

    private TextView text(String value, float size, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        view.setBreakStrategy(Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? android.text.Layout.BREAK_STRATEGY_HIGH_QUALITY : 0);
        return view;
    }

    private Button actionButton(String label, int background, int border) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setBackground(rounded(background, border, 15, 1));
        return button;
    }

    private LinearLayout.LayoutParams matchWrap(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = topMargin;
        return params;
    }

    private GradientDrawable rounded(int fill, int stroke, int radiusDp, int strokeDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(strokeDp), stroke);
        return drawable;
    }

    private GradientDrawable circle(int fill, int stroke, int strokeDp) {
        GradientDrawable drawable = rounded(fill, stroke, 100, strokeDp);
        drawable.setShape(GradientDrawable.OVAL);
        return drawable;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    @Override public void onBackPressed() {
        // An alarm cannot be silently dismissed with the system Back action.
    }

    @Override protected void onDestroy() {
        clockHandler.removeCallbacks(clockTick);
        if (changedReceiver != null) {
            try { unregisterReceiver(changedReceiver); } catch (IllegalArgumentException ignored) {}
        }
        super.onDestroy();
    }
}
