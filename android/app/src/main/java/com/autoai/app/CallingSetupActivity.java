package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;

public final class CallingSetupActivity extends AppCompatActivity {
    public static final String ACTION_SETUP_CHANGED = "com.autoai.app.CALLING_SETUP_CHANGED";
    private static final int REQUEST_PERMISSION = 7041;
    private LinearLayout checklist;
    private TextView statusText;
    private String pendingPermission;
    private String pendingKey;
    private static volatile boolean visible;

    public static boolean isVisible() { return visible; }
    @Override protected void onStart() { super.onStart(); visible = true; }
    @Override protected void onStop() { visible = false; super.onStop(); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        pendingPermission = state == null ? null : state.getString("pendingPermission");
        pendingKey = state == null ? null : state.getString("pendingKey");
        buildUi();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { confirmLimitedMode(); }
        });
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        out.putString("pendingPermission", pendingPermission);
        out.putString("pendingKey", pendingKey);
        super.onSaveInstanceState(out);
    }

    @Override protected void onResume() { super.onResume(); if (checklist != null) render(); }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(10, 15, 25));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(28), dp(24), dp(24));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        TextView title = text("Complete Calling Setup", 26, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);
        TextView description = text("Allow these settings so AutoAI can receive audio and video calls when the app is in the background or your screen is locked.", 15, Color.rgb(190, 200, 215));
        description.setPadding(0, dp(10), 0, dp(20));
        root.addView(description);
        statusText = text("", 14, Color.rgb(245, 183, 70));
        root.addView(statusText);
        checklist = new LinearLayout(this);
        checklist.setOrientation(LinearLayout.VERTICAL);
        root.addView(checklist, new LinearLayout.LayoutParams(-1, -2));

        Button primary = button("Continue Setup");
        primary.setOnClickListener(v -> continueSetup());
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-1, dp(52));
        primaryParams.topMargin = dp(22);
        root.addView(primary, primaryParams);
        Button limited = button("Use Limited Mode");
        limited.setBackgroundColor(Color.TRANSPARENT);
        limited.setTextColor(Color.rgb(190, 200, 215));
        limited.setOnClickListener(v -> confirmLimitedMode());
        root.addView(limited, new LinearLayout.LayoutParams(-1, dp(48)));
        setContentView(scroll);
        render();
    }

    private void render() {
        CallingPermissionCoordinator.Snapshot snapshot = CallingPermissionCoordinator.inspect(this);
        checklist.removeAllViews();
        addRow("Call notifications", worst(snapshot, "notifications", "incomingChannel"), "notifications");
        addRow("Microphone", snapshot.items.get("microphone"), "microphone");
        addRow("Camera", snapshot.items.get("camera"), "camera");
        addRow("Bluetooth audio", snapshot.items.get("bluetooth"), "bluetooth");
        addRow("Full-screen incoming calls", snapshot.items.get("fullScreen"), "fullScreen");
        addRow("Background reliability", worst(snapshot, "battery", "firebase", "playServices", "foregroundService", "telecom"), "battery");
        statusText.setText(snapshot.status == CallingPermissionCoordinator.Status.READY ? "Calling setup is ready." :
            snapshot.status == CallingPermissionCoordinator.Status.LIMITED ? "Calls can work with the limitations shown below." :
            "One or more required settings currently block calling.");
    }

    private void addRow(String label, CallingPermissionCoordinator.ItemState state, String item) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(2), dp(12), dp(2), dp(12));
        TextView icon = text(icon(state), 20, color(state));
        row.addView(icon, new LinearLayout.LayoutParams(dp(34), -2));
        TextView value = text(label + "\n" + stateLabel(state), 15, Color.WHITE);
        row.addView(value, new LinearLayout.LayoutParams(0, -2, 1));
        if (state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED || state == CallingPermissionCoordinator.ItemState.SPECIAL_ACCESS_REQUIRED || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED) {
            Button fix = button("Open settings");
            fix.setTextSize(12);
            fix.setOnClickListener(v -> openSetting(item, state));
            row.addView(fix, new LinearLayout.LayoutParams(dp(112), dp(42)));
        }
        checklist.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    private void continueSetup() {
        CallingPermissionCoordinator.Snapshot snapshot = CallingPermissionCoordinator.inspect(this);
        if (requestIfAvailable(snapshot, "notifications", Manifest.permission.POST_NOTIFICATIONS, "notification_prompted",
            "Allow call notifications", "Allow notifications so incoming calls and messages can appear when AutoAI is in the background.")) return;
        if (requestIfAvailable(snapshot, "microphone", Manifest.permission.RECORD_AUDIO, "microphone_prompted",
            "Allow microphone", "Microphone access is required to speak during audio and video calls.")) return;
        if (requestIfAvailable(snapshot, "camera", Manifest.permission.CAMERA, "camera_prompted",
            "Allow camera", "Camera access is required only for video calls.")) return;
        if (Build.VERSION.SDK_INT >= 31 && requestIfAvailable(snapshot, "bluetooth", Manifest.permission.BLUETOOTH_CONNECT, "bluetooth_prompted",
            "Allow Bluetooth audio", "Allow nearby-device access to use Bluetooth headphones during calls.")) return;
        for (String item : new String[]{"notifications", "incomingChannel", "microphone", "camera", "bluetooth", "fullScreen", "battery"}) {
            CallingPermissionCoordinator.ItemState state = snapshot.items.get(item);
            if (state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED || state == CallingPermissionCoordinator.ItemState.SPECIAL_ACCESS_REQUIRED) {
                openSetting(item, state);
                return;
            }
        }
        finishWithDecision();
    }

    private boolean requestIfAvailable(CallingPermissionCoordinator.Snapshot snapshot, String item, String permission, String key, String title, String rationale) {
        if (snapshot.items.get(item) != CallingPermissionCoordinator.ItemState.PROMPT_AVAILABLE && snapshot.items.get(item) != CallingPermissionCoordinator.ItemState.DENIED) return false;
        pendingPermission = permission;
        pendingKey = key;
        new AlertDialog.Builder(this).setTitle(title).setMessage(rationale).setNegativeButton("Not now", (d, w) -> {
            CallingPermissionCoordinator.preferences(this).edit().putBoolean(key, true).apply(); render();
        }).setPositiveButton("Continue", (d, w) -> {
            CallingPermissionCoordinator.preferences(this).edit().putBoolean(key, true).apply();
            requestPermissions(new String[]{permission}, REQUEST_PERMISSION);
        }).show();
        return true;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_PERMISSION) return;
        pendingPermission = null;
        pendingKey = null;
        render();
    }

    private void openSetting(String item, CallingPermissionCoordinator.ItemState state) {
        if ("fullScreen".equals(item)) CallingPermissionCoordinator.preferences(this).edit().putBoolean("full_screen_explained", true).apply();
        if ("battery".equals(item)) CallingPermissionCoordinator.preferences(this).edit().putBoolean("battery_settings_explained", true).apply();
        try { startActivity(CallingPermissionCoordinator.settingIntent(this, item)); }
        catch (RuntimeException ignored) { startActivity(CallingPermissionCoordinator.settingIntent(this, "app")); }
    }

    private void confirmLimitedMode() {
        new AlertDialog.Builder(this).setTitle("Use Limited Mode?")
            .setMessage("You can continue using AutoAI. Calling limitations will remain visible in Settings > Calls.")
            .setNegativeButton("Keep setting up", null).setPositiveButton("Use Limited Mode", (d, w) -> finishWithDecision()).show();
    }

    private void finishWithDecision() {
        CallingPermissionCoordinator.completeCurrentVersion(this);
        sendBroadcast(new Intent(ACTION_SETUP_CHANGED).setPackage(getPackageName()));
        setResult(RESULT_OK);
        finish();
    }

    private CallingPermissionCoordinator.ItemState worst(CallingPermissionCoordinator.Snapshot snapshot, String... keys) {
        CallingPermissionCoordinator.ItemState result = CallingPermissionCoordinator.ItemState.GRANTED;
        for (String key : keys) {
            CallingPermissionCoordinator.ItemState value = snapshot.items.get(key);
            if (value == CallingPermissionCoordinator.ItemState.UNAVAILABLE || value == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED || value == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED || value == CallingPermissionCoordinator.ItemState.DENIED) return value;
            if (value != CallingPermissionCoordinator.ItemState.GRANTED && value != CallingPermissionCoordinator.ItemState.NOT_REQUIRED) result = value;
        }
        return result;
    }

    private String icon(CallingPermissionCoordinator.ItemState state) {
        if (state == CallingPermissionCoordinator.ItemState.GRANTED) return "✓";
        if (state == CallingPermissionCoordinator.ItemState.NOT_REQUIRED) return "—";
        if (state == CallingPermissionCoordinator.ItemState.UNAVAILABLE || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED || state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED) return "●";
        return "▲";
    }
    private int color(CallingPermissionCoordinator.ItemState state) {
        if (state == CallingPermissionCoordinator.ItemState.GRANTED) return Color.rgb(65, 210, 140);
        if (state == CallingPermissionCoordinator.ItemState.NOT_REQUIRED) return Color.rgb(145, 155, 170);
        if (state == CallingPermissionCoordinator.ItemState.UNAVAILABLE || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED || state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED) return Color.rgb(245, 92, 92);
        return Color.rgb(245, 183, 70);
    }
    private String stateLabel(CallingPermissionCoordinator.ItemState state) { return state.name().toLowerCase().replace('_', ' '); }
    private TextView text(String value, int size, int color) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view; }
    private Button button(String value) { Button button = new Button(this); button.setText(value); button.setAllCaps(false); return button; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
