package com.autoai.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;

/** Compact native update surface. Durable state remains in AppUpdateCoordinator. */
public final class AppUpdateDialog implements AppUpdateCoordinator.Listener {
    private final Activity activity;
    private final AppUpdateCoordinator coordinator;
    private Dialog dialog;
    private TextView eyebrow, title, version, details, status, progressText;
    private ProgressBar progress;
    private Button primary, secondary;

    public AppUpdateDialog(Activity activity) {
        this.activity = activity;
        coordinator = AppUpdateCoordinator.get(activity);
    }

    public void start() { coordinator.addListener(this); }
    public void stop() {
        coordinator.removeListener(this);
        if (dialog != null) dialog.dismiss();
        dialog = null;
    }

    @Override public void onUpdateChanged(AppUpdateCoordinator.Snapshot snapshot) {
        activity.runOnUiThread(() -> render(snapshot));
    }

    private void render(AppUpdateCoordinator.Snapshot snapshot) {
        if (activity.isFinishing() || (Build.VERSION.SDK_INT >= 17 && activity.isDestroyed())) return;
        boolean visible = snapshot.metadata != null
            && snapshot.metadata.versionCode > BuildConfig.VERSION_CODE
            && snapshot.state != AppUpdateCoordinator.State.IDLE
            && snapshot.state != AppUpdateCoordinator.State.INSTALLED;
        if (!visible) {
            if (dialog != null) dialog.dismiss();
            dialog = null;
            return;
        }
        if (dialog == null) create();

        AppUpdateCoordinator.Metadata metadata = snapshot.metadata;
        eyebrow.setText(metadata.mandatory ? "MANDATORY SECURITY UPDATE" : "AUTOAI RELEASE");
        eyebrow.setTextColor(metadata.mandatory ? Color.rgb(255, 181, 71) : Color.rgb(104, 227, 255));
        title.setText(metadata.mandatory ? "Update Required" : "A smarter AutoAI is ready");
        version.setText("v" + BuildConfig.VERSION_NAME + "  →  v" + metadata.versionName
            + "   •   " + formatSize(metadata.fileSize));
        details.setText(releaseDetails(metadata));
        status.setText(TextUtils.isEmpty(snapshot.message) ? label(snapshot.state) : snapshot.message);
        status.setTextColor(snapshot.state == AppUpdateCoordinator.State.FAILED
            ? Color.rgb(255, 104, 124)
            : snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL
                ? Color.rgb(80, 231, 168) : Color.rgb(112, 216, 255));

        boolean downloading = snapshot.state == AppUpdateCoordinator.State.DOWNLOADING
            || snapshot.state == AppUpdateCoordinator.State.VERIFYING
            || snapshot.state == AppUpdateCoordinator.State.QUEUED
            || snapshot.state == AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK;
        progress.setVisibility(downloading ? View.VISIBLE : View.GONE);
        progressText.setVisibility(downloading ? View.VISIBLE : View.GONE);
        if (downloading && snapshot.totalBytes > 0) {
            int percent = (int) Math.min(100, snapshot.downloadedBytes * 100 / snapshot.totalBytes);
            progress.setIndeterminate(false);
            progress.setProgress(percent);
            progressText.setText(formatSize(snapshot.downloadedBytes) + " / "
                + formatSize(snapshot.totalBytes) + "   •   " + percent + "%");
        } else if (downloading) {
            progress.setIndeterminate(true);
            progressText.setText(snapshot.downloadedBytes > 0 ? formatSize(snapshot.downloadedBytes) : "Preparing secure download…");
        }

        primary.setEnabled(!downloading);
        primary.setAlpha(downloading ? 0.65f : 1f);
        primary.setText(action(snapshot.state));
        primary.setOnClickListener(view -> primary(snapshot));

        boolean mandatoryFailure = metadata.mandatory && snapshot.state == AppUpdateCoordinator.State.FAILED;
        boolean optionalSecondary = !metadata.mandatory && (snapshot.state == AppUpdateCoordinator.State.AVAILABLE
            || snapshot.state == AppUpdateCoordinator.State.FAILED || downloading);
        secondary.setVisibility(mandatoryFailure || optionalSecondary ? View.VISIBLE : View.GONE);
        secondary.setText(mandatoryFailure ? "Exit App" : downloading ? "Cancel Download" : "Maybe Later");
        secondary.setOnClickListener(view -> {
            if (mandatoryFailure) activity.finishAndRemoveTask();
            else if (downloading) coordinator.cancelOptional();
            else coordinator.dismissOptional();
        });

        dialog.setCancelable(!metadata.mandatory);
        dialog.setCanceledOnTouchOutside(!metadata.mandatory);
        if (!dialog.isShowing()) {
            dialog.show();
            sizeWindow();
        }
    }

    private void create() {
        dialog = new Dialog(activity);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(buildCard());
        dialog.setOnKeyListener((ignored, keyCode, event) -> keyCode == KeyEvent.KEYCODE_BACK
            && event.getAction() == KeyEvent.ACTION_UP
            && coordinator.current().metadata != null
            && coordinator.current().metadata.mandatory);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.dimAmount = 0.76f;
            window.setAttributes(attributes);
        }
    }

    private View buildCard() {
        LinearLayout card = column();
        card.setPadding(dp(20), dp(18), dp(20), dp(16));
        card.setBackground(gradient(new int[]{Color.rgb(29, 18, 67), Color.rgb(10, 28, 58), Color.rgb(4, 51, 61)}, 24, Color.rgb(104, 77, 255)));

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(activity);
        logo.setImageResource(R.mipmap.ic_launcher);
        logo.setScaleType(ImageView.ScaleType.CENTER_CROP);
        GradientDrawable logoBackground = gradient(new int[]{Color.rgb(39, 34, 93), Color.rgb(7, 75, 93)}, 18, Color.rgb(46, 225, 255));
        logo.setBackground(logoBackground);
        logo.setPadding(dp(5), dp(5), dp(5), dp(5));
        header.addView(logo, new LinearLayout.LayoutParams(dp(58), dp(58)));

        LinearLayout heading = column();
        LinearLayout.LayoutParams headingParams = new LinearLayout.LayoutParams(0, -2, 1f);
        headingParams.leftMargin = dp(13);
        eyebrow = text("", 11, Color.rgb(104, 227, 255));
        eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
        eyebrow.setLetterSpacing(0.08f);
        title = text("", 21, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, dp(3), 0, 0);
        heading.addView(eyebrow);
        heading.addView(title);
        header.addView(heading, headingParams);
        card.addView(header);

        version = text("", 13, Color.rgb(167, 211, 255));
        version.setGravity(Gravity.CENTER);
        version.setPadding(dp(10), dp(8), dp(10), dp(8));
        version.setBackground(gradient(new int[]{Color.rgb(37, 35, 85), Color.rgb(15, 61, 83)}, 13, Color.rgb(64, 125, 214)));
        LinearLayout.LayoutParams versionParams = new LinearLayout.LayoutParams(-1, -2);
        versionParams.topMargin = dp(15);
        card.addView(version, versionParams);

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(false);
        scroll.setVerticalScrollBarEnabled(false);
        details = text("", 14, Color.rgb(224, 229, 247));
        details.setLineSpacing(dp(3), 1f);
        details.setPadding(dp(2), dp(14), dp(2), dp(12));
        scroll.addView(details, new ScrollView.LayoutParams(-1, -2));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(-1, 0, 1f);
        scrollParams.weight = 1f;
        card.addView(scroll, scrollParams);

        status = text("", 13, Color.rgb(112, 216, 255));
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setPadding(0, dp(7), 0, dp(5));
        card.addView(status);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        card.addView(progress, new LinearLayout.LayoutParams(-1, dp(8)));
        progressText = text("", 12, Color.rgb(159, 205, 255));
        progressText.setPadding(0, dp(5), 0, 0);
        card.addView(progressText);

        primary = new Button(activity);
        primary.setTextColor(Color.WHITE);
        primary.setAllCaps(false);
        primary.setTextSize(16);
        primary.setTypeface(Typeface.DEFAULT_BOLD);
        primary.setBackground(gradient(new int[]{Color.rgb(147, 58, 255), Color.rgb(40, 111, 247), Color.rgb(0, 203, 235)}, 15, Color.TRANSPARENT));
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-1, dp(52));
        primaryParams.topMargin = dp(13);
        card.addView(primary, primaryParams);

        secondary = new Button(activity);
        secondary.setTextColor(Color.rgb(203, 213, 243));
        secondary.setAllCaps(false);
        secondary.setTextSize(14);
        secondary.setBackgroundColor(Color.TRANSPARENT);
        card.addView(secondary, new LinearLayout.LayoutParams(-1, dp(44)));
        return card;
    }

    private void sizeWindow() {
        Window window = dialog.getWindow();
        if (window == null) return;
        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
        int width = Math.min(screenWidth - dp(28), dp(520));
        int height = Math.min((int) (screenHeight * 0.84f), dp(650));
        window.setLayout(width, height);
        window.setGravity(Gravity.CENTER);
    }

    private String releaseDetails(AppUpdateCoordinator.Metadata metadata) {
        String notes = metadata.changelog == null || metadata.changelog.trim().isEmpty()
            ? "• Faster and more reliable AutoAI experience\n• Stability and security improvements"
            : metadata.changelog.trim();
        return "WHAT’S NEW\n" + notes
            + "\n\n✓ SHA-256 verified download"
            + "\n✓ Official AutoAI package"
            + (metadata.releaseDate.isEmpty() ? "" : "\n\nReleased " + metadata.releaseDate);
    }

    private void primary(AppUpdateCoordinator.Snapshot snapshot) {
        switch (snapshot.state) {
            case AVAILABLE:
            case FAILED:
                coordinator.download();
                break;
            case READY_TO_INSTALL:
                if (!coordinator.canInstallPackages()) {
                    coordinator.requireInstallPermission();
                    activity.startActivity(coordinator.installPermissionIntent());
                } else openInstaller();
                break;
            case INSTALL_PERMISSION_REQUIRED:
                activity.startActivity(coordinator.installPermissionIntent());
                break;
            default:
                coordinator.check(true);
        }
    }

    private void openInstaller() {
        Intent intent = coordinator.installerIntent();
        if (intent == null) return;
        try {
            activity.startActivity(intent);
        } catch (RuntimeException error) {
            android.widget.Toast.makeText(activity, "Android installer is unavailable.", android.widget.Toast.LENGTH_LONG).show();
        }
    }

    private String action(AppUpdateCoordinator.State state) {
        switch (state) {
            case AVAILABLE: return "Download & Update";
            case READY_TO_INSTALL: return "Install Update";
            case INSTALL_PERMISSION_REQUIRED: return "Allow Installation";
            case FAILED: return "Retry Update";
            case CHECKING: return "Checking…";
            default: return "Downloading…";
        }
    }

    private String label(AppUpdateCoordinator.State state) {
        return state.name().toLowerCase(Locale.US).replace('_', ' ');
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private GradientDrawable gradient(int[] colors, int radius, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR, colors);
        drawable.setCornerRadius(dp(radius));
        if (strokeColor != Color.TRANSPARENT) drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static String formatSize(long bytes) {
        return bytes <= 0 ? "Size calculating" : String.format(Locale.US, "%.1f MB", bytes / 1048576.0);
    }
}
