package com.autoai.app;

import android.Manifest;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
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

/**
 * State-driven calling permission setup.
 *
 * Android owns the secure runtime permission dialog, so AutoAI first explains
 * why a missing permission is needed and only then opens the system prompt.
 * Granted permissions are never requested again.
 */
public final class CallingSetupActivity extends AppCompatActivity {
    public static final String ACTION_SETUP_CHANGED = "com.autoai.app.CALLING_SETUP_CHANGED";
    private static final int REQUEST_PERMISSION = 7041;

    private LinearLayout checklist;
    private LinearLayout recommendationArea;
    private TextView statusText;
    private TextView progressText;
    private Button primary;
    private String pendingPermission;
    private String pendingKey;
    private boolean hasPendingItems;
    private static volatile boolean visible;

    public static boolean isVisible() { return visible; }
    @Override protected void onStart() { super.onStart(); visible = true; }
    @Override protected void onStop() { visible = false; super.onStop(); }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        pendingPermission = state == null ? null : state.getString("pendingPermission");
        pendingKey = state == null ? null : state.getString("pendingKey");
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        buildUi();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (hasPendingItems) confirmLimitedMode();
                else finishWithDecision();
            }
        });
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        out.putString("pendingPermission", pendingPermission);
        out.putString("pendingKey", pendingKey);
        super.onSaveInstanceState(out);
    }

    @Override protected void onResume() {
        super.onResume();
        CallingPermissionCoordinator.invalidateCachedState();
        if (checklist != null) render();
        sendBroadcast(new Intent(ACTION_SETUP_CHANGED).setPackage(getPackageName()));
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setBackgroundColor(BACKGROUND);
        scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(24), dp(20), dp(28));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));

        TextView eyebrow = text("AUTOAI  •  CALL READY", 12, ACCENT);
        eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
        eyebrow.setLetterSpacing(0.08f);
        root.addView(eyebrow);

        TextView title = text("Calling permissions", 28, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(10);
        root.addView(title, titleParams);

        TextView description = text(
            "AutoAI only asks for access that is currently missing. Permissions you already allowed stay untouched.",
            15, MUTED
        );
        description.setLineSpacing(0, 1.18f);
        LinearLayout.LayoutParams descriptionParams = new LinearLayout.LayoutParams(-1, -2);
        descriptionParams.topMargin = dp(8);
        descriptionParams.bottomMargin = dp(18);
        root.addView(description, descriptionParams);

        LinearLayout summary = card();
        TextView summaryLabel = text("SETUP STATUS", 11, MUTED);
        summaryLabel.setTypeface(Typeface.DEFAULT_BOLD);
        summaryLabel.setLetterSpacing(0.08f);
        summary.addView(summaryLabel);
        statusText = text("", 18, Color.WHITE);
        statusText.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2);
        statusParams.topMargin = dp(6);
        summary.addView(statusText, statusParams);
        progressText = text("", 13, MUTED);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, -2);
        progressParams.topMargin = dp(5);
        summary.addView(progressText, progressParams);
        root.addView(summary);

        TextView pendingLabel = text("ACTION NEEDED", 11, MUTED);
        pendingLabel.setTypeface(Typeface.DEFAULT_BOLD);
        pendingLabel.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams pendingLabelParams = new LinearLayout.LayoutParams(-1, -2);
        pendingLabelParams.topMargin = dp(22);
        pendingLabelParams.bottomMargin = dp(8);
        root.addView(pendingLabel, pendingLabelParams);

        checklist = new LinearLayout(this);
        checklist.setOrientation(LinearLayout.VERTICAL);
        root.addView(checklist, new LinearLayout.LayoutParams(-1, -2));

        recommendationArea = new LinearLayout(this);
        recommendationArea.setOrientation(LinearLayout.VERTICAL);
        root.addView(recommendationArea, new LinearLayout.LayoutParams(-1, -2));

        primary = button("Allow missing permissions");
        primary.setTextColor(Color.WHITE);
        primary.setTypeface(Typeface.DEFAULT_BOLD);
        primary.setBackground(rounded(ACCENT, 16));
        primary.setOnClickListener(v -> {
            if (hasPendingItems) continueSetup();
            else finishWithDecision();
        });
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-1, dp(54));
        primaryParams.topMargin = dp(24);
        root.addView(primary, primaryParams);

        Button limited = button("Continue for now");
        limited.setTextColor(MUTED);
        limited.setBackground(rounded(Color.TRANSPARENT, 16, BORDER));
        limited.setOnClickListener(v -> {
            if (hasPendingItems) confirmLimitedMode();
            else finishWithDecision();
        });
        LinearLayout.LayoutParams limitedParams = new LinearLayout.LayoutParams(-1, dp(50));
        limitedParams.topMargin = dp(10);
        root.addView(limited, limitedParams);

        TextView privacy = text(
            "You can change these permissions anytime in AutoAI Settings or Android App info.",
            12, MUTED
        );
        privacy.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams privacyParams = new LinearLayout.LayoutParams(-1, -2);
        privacyParams.topMargin = dp(14);
        root.addView(privacy, privacyParams);

        setContentView(scroll);
        render();
    }

    private void render() {
        CallingPermissionCoordinator.Snapshot snapshot = CallingPermissionCoordinator.inspect(this);
        checklist.removeAllViews();
        recommendationArea.removeAllViews();

        int total = 6;
        int ready = 0;
        CallingPermissionCoordinator.ItemState notificationState = worst(snapshot, "notifications", "incomingChannel");
        String notificationAction = snapshot.permissionItems.get("incomingChannel")
            == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED ? "incomingChannel" : "notifications";
        ready += addPendingIfNeeded("Call notifications", "Show incoming calls while AutoAI is closed.",
            notificationState, notificationAction) ? 0 : 1;
        ready += addPendingIfNeeded("Microphone", "Speak during audio and video calls.",
            snapshot.permissionItems.get("microphone"), "microphone") ? 0 : 1;
        ready += addPendingIfNeeded("Camera", "Turn on video only when you start or accept a video call.",
            snapshot.permissionItems.get("camera"), "camera") ? 0 : 1;
        ready += addPendingIfNeeded("Bluetooth audio", "Use wireless headsets and car audio during calls.",
            snapshot.permissionItems.get("bluetooth"), "bluetooth") ? 0 : 1;
        ready += addPendingIfNeeded("Full-screen incoming calls", "Display the incoming call screen when the phone is locked.",
            snapshot.permissionItems.get("fullScreen"), "fullScreen") ? 0 : 1;

        CallingPermissionCoordinator.ItemState background = snapshot.permissionItems.get("backgroundActivity");
        boolean backgroundRequired = background != CallingPermissionCoordinator.ItemState.GRANTED
            && background != CallingPermissionCoordinator.ItemState.NOT_REQUIRED
            && background != CallingPermissionCoordinator.ItemState.LIMITED;
        if (backgroundRequired) {
            addPendingRow("Background activity", "Android is restricting AutoAI. Incoming calls may not arrive until the app is opened.",
                background, "backgroundActivity");
        } else {
            ready++;
        }

        hasPendingItems = ready < total;
        statusText.setText(hasPendingItems ? "A few steps remain" : "Ready for calls");
        statusText.setTextColor(hasPendingItems ? WARNING : SUCCESS);
        progressText.setText(ready + " of " + total + " call settings ready");

        if (!hasPendingItems) {
            addSuccessCard();
        }

        if (background == CallingPermissionCoordinator.ItemState.LIMITED) {
            addBatteryRecommendation();
        }

        primary.setText(hasPendingItems
            ? "Allow " + (total - ready) + " missing " + ((total - ready) == 1 ? "setting" : "settings")
            : "Done");
    }

    private boolean addPendingIfNeeded(String label, String detail, CallingPermissionCoordinator.ItemState state, String item) {
        boolean ready = state == CallingPermissionCoordinator.ItemState.GRANTED
            || state == CallingPermissionCoordinator.ItemState.NOT_REQUIRED;
        if (!ready) addPendingRow(label, detail, state, item);
        return !ready;
    }

    private void addPendingRow(String label, String detail, CallingPermissionCoordinator.ItemState state, String item) {
        LinearLayout card = card();
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView marker = text("!", 14, Color.WHITE);
        marker.setTypeface(Typeface.DEFAULT_BOLD);
        marker.setGravity(Gravity.CENTER);
        marker.setBackground(rounded(color(state), 18));
        header.addView(marker, new LinearLayout.LayoutParams(dp(34), dp(34)));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        TextView name = text(label, 15, Color.WHITE);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        copy.addView(name);
        TextView stateView = text(stateLabel(state, item), 12, color(state));
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(-1, -2);
        stateParams.topMargin = dp(2);
        copy.addView(stateView, stateParams);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1);
        copyParams.leftMargin = dp(12);
        header.addView(copy, copyParams);
        card.addView(header);

        TextView description = text(detail, 13, MUTED);
        description.setLineSpacing(0, 1.15f);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(10);
        card.addView(description, detailParams);

        if (needsSettingsButton(state, item)) {
            Button fix = button("Open Android settings");
            fix.setTextColor(ACCENT_LIGHT);
            fix.setBackground(rounded(Color.TRANSPARENT, 12, BORDER));
            fix.setOnClickListener(v -> openSetting(item, state));
            LinearLayout.LayoutParams fixParams = new LinearLayout.LayoutParams(-1, dp(44));
            fixParams.topMargin = dp(12);
            card.addView(fix, fixParams);
        }

        LinearLayout.LayoutParams cardParams = new LinearLayout.LayoutParams(-1, -2);
        cardParams.bottomMargin = dp(10);
        checklist.addView(card, cardParams);
    }

    private void addSuccessCard() {
        LinearLayout success = card();
        success.setBackground(rounded(Color.rgb(16, 50, 47), 18, Color.rgb(38, 113, 94)));
        TextView title = text("All required access is ready", 15, SUCCESS);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        success.addView(title);
        TextView detail = text("AutoAI will not ask for these permissions again unless you revoke one in Android settings.", 13, MUTED);
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(6);
        success.addView(detail, detailParams);
        checklist.addView(success);
    }

    private void addBatteryRecommendation() {
        TextView label = text("OPTIONAL RELIABILITY", 11, MUTED);
        label.setTypeface(Typeface.DEFAULT_BOLD);
        label.setLetterSpacing(0.08f);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(-1, -2);
        labelParams.topMargin = dp(18);
        labelParams.bottomMargin = dp(8);
        recommendationArea.addView(label, labelParams);

        LinearLayout card = card();
        TextView title = text("Improve background call reliability", 15, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(title);
        TextView detail = text(
            "Battery optimization is on. Calls can still work, but some phones may delay them while AutoAI is closed.",
            13, MUTED
        );
        LinearLayout.LayoutParams detailParams = new LinearLayout.LayoutParams(-1, -2);
        detailParams.topMargin = dp(6);
        card.addView(detail, detailParams);
        Button action = button("Review battery settings");
        action.setTextColor(ACCENT_LIGHT);
        action.setBackground(rounded(Color.TRANSPARENT, 12, BORDER));
        action.setOnClickListener(v -> openSetting("backgroundActivity", CallingPermissionCoordinator.ItemState.LIMITED));
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(-1, dp(44));
        actionParams.topMargin = dp(12);
        card.addView(action, actionParams);
        recommendationArea.addView(card);
    }

    private void continueSetup() {
        CallingPermissionCoordinator.Snapshot snapshot = CallingPermissionCoordinator.inspect(this);
        if (requestIfAvailable(snapshot, "notifications", Manifest.permission.POST_NOTIFICATIONS, "notification_prompted",
            "Allow call notifications", "AutoAI uses notifications to show incoming calls and messages while the app is in the background.")) return;
        if (requestIfAvailable(snapshot, "microphone", Manifest.permission.RECORD_AUDIO, "microphone_prompted",
            "Allow microphone", "Microphone access lets the other person hear you during audio and video calls.")) return;
        if (requestIfAvailable(snapshot, "camera", Manifest.permission.CAMERA, "camera_prompted",
            "Allow camera", "Camera access is used only when you start or accept a video call.")) return;
        if (Build.VERSION.SDK_INT >= 31 && requestIfAvailable(snapshot, "bluetooth", Manifest.permission.BLUETOOTH_CONNECT, "bluetooth_prompted",
            "Allow Bluetooth audio", "Nearby-device access lets AutoAI connect call audio to Bluetooth headsets and car audio.")) return;

        for (String item : new String[]{"notifications", "incomingChannel", "microphone", "camera", "bluetooth", "fullScreen", "backgroundActivity"}) {
            CallingPermissionCoordinator.ItemState state = snapshot.permissionItems.get(item);
            if (needsSettingsButton(state, item)
                && !("backgroundActivity".equals(item) && state == CallingPermissionCoordinator.ItemState.LIMITED)) {
                openSetting(item, state);
                return;
            }
        }
        finishWithDecision();
    }

    private boolean requestIfAvailable(
        CallingPermissionCoordinator.Snapshot snapshot,
        String item,
        String permission,
        String key,
        String title,
        String rationale
    ) {
        CallingPermissionCoordinator.ItemState state = snapshot.permissionItems.get(item);
        if (state != CallingPermissionCoordinator.ItemState.PROMPT_AVAILABLE
            && state != CallingPermissionCoordinator.ItemState.DENIED) return false;

        pendingPermission = permission;
        pendingKey = key;
        new AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(rationale + "\n\nAndroid will show the secure system permission dialog next.")
            .setNegativeButton("Not now", (dialog, which) -> {
                pendingPermission = null;
                pendingKey = null;
                // Do not mark this as an Android denial. The system prompt was
                // never opened, so asking later must remain possible.
                render();
            })
            .setPositiveButton("Continue", (dialog, which) -> {
                CallingPermissionCoordinator.preferences(this).edit().putBoolean(key, true).apply();
                requestPermissions(new String[]{permission}, REQUEST_PERMISSION);
            })
            .show();
        return true;
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_PERMISSION) return;
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        pendingPermission = null;
        pendingKey = null;
        render();
        if (granted) checklist.postDelayed(this::continueSetup, 250L);
    }

    private void openSetting(String item, CallingPermissionCoordinator.ItemState state) {
        if ("fullScreen".equals(item)) {
            CallingPermissionCoordinator.preferences(this).edit().putBoolean("full_screen_explained", true).apply();
        }
        if ("backgroundActivity".equals(item)) {
            CallingPermissionCoordinator.preferences(this).edit().putBoolean("battery_settings_explained", true).apply();
        }
        try {
            startActivity(CallingPermissionCoordinator.settingIntent(this, item));
        } catch (RuntimeException ignored) {
            startActivity(CallingPermissionCoordinator.settingIntent(this, "app"));
        }
    }

    private void confirmLimitedMode() {
        new AlertDialog.Builder(this)
            .setTitle("Continue without finishing?")
            .setMessage("You can use AutoAI now. Missing call access will remain visible in Settings > Calls, and some incoming-call features may be limited.")
            .setNegativeButton("Keep setting up", null)
            .setPositiveButton("Continue for now", (dialog, which) -> finishWithDecision())
            .show();
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
            CallingPermissionCoordinator.ItemState value = snapshot.permissionItems.get(key);
            if (value == CallingPermissionCoordinator.ItemState.UNAVAILABLE
                || value == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED
                || value == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED
                || value == CallingPermissionCoordinator.ItemState.DENIED) return value;
            if (value != CallingPermissionCoordinator.ItemState.GRANTED
                && value != CallingPermissionCoordinator.ItemState.NOT_REQUIRED) result = value;
        }
        return result;
    }

    private boolean needsSettingsButton(CallingPermissionCoordinator.ItemState state, String item) {
        return state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED
            || state == CallingPermissionCoordinator.ItemState.SPECIAL_ACCESS_REQUIRED
            || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED
            || ("backgroundActivity".equals(item)
                && (state == CallingPermissionCoordinator.ItemState.LIMITED
                    || state == CallingPermissionCoordinator.ItemState.DENIED));
    }

    private String stateLabel(CallingPermissionCoordinator.ItemState state, String item) {
        if ("backgroundActivity".equals(item)) {
            if (state == CallingPermissionCoordinator.ItemState.LIMITED) return "Recommended";
            if (state == CallingPermissionCoordinator.ItemState.DENIED) return "Restricted by Android";
        }
        if (state == CallingPermissionCoordinator.ItemState.PROMPT_AVAILABLE) return "Permission not granted";
        if (state == CallingPermissionCoordinator.ItemState.DENIED) return "Permission denied";
        if (state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED) return "Enable in Android settings";
        if (state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED) return "Incoming-call alerts are disabled";
        if (state == CallingPermissionCoordinator.ItemState.SPECIAL_ACCESS_REQUIRED) return "Special access required";
        return "Action needed";
    }

    private int color(CallingPermissionCoordinator.ItemState state) {
        if (state == CallingPermissionCoordinator.ItemState.DENIED
            || state == CallingPermissionCoordinator.ItemState.PERMANENTLY_DENIED
            || state == CallingPermissionCoordinator.ItemState.CHANNEL_DISABLED
            || state == CallingPermissionCoordinator.ItemState.UNAVAILABLE) return DANGER;
        return WARNING;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(15), dp(16), dp(15));
        card.setBackground(rounded(CARD, 18, BORDER));
        return card;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private Button button(String value) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(12), 0, dp(12), 0);
        button.setStateListAnimator(null);
        return button;
    }

    private GradientDrawable rounded(int fill, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private GradientDrawable rounded(int fill, int radius, int stroke) {
        GradientDrawable drawable = rounded(fill, radius);
        drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static final int BACKGROUND = Color.rgb(7, 12, 23);
    private static final int CARD = Color.rgb(18, 27, 45);
    private static final int BORDER = Color.rgb(43, 58, 82);
    private static final int MUTED = Color.rgb(165, 178, 199);
    private static final int ACCENT = Color.rgb(92, 89, 255);
    private static final int ACCENT_LIGHT = Color.rgb(151, 166, 255);
    private static final int SUCCESS = Color.rgb(79, 218, 158);
    private static final int WARNING = Color.rgb(248, 184, 73);
    private static final int DANGER = Color.rgb(250, 101, 110);
}
