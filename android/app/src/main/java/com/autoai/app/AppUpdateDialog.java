package com.autoai.app;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ContextThemeWrapper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.util.Locale;
import java.util.Date;
import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.util.TimeZone;

/** Compact native update surface. Durable state remains in AppUpdateCoordinator. */
public final class AppUpdateDialog implements AppUpdateCoordinator.Listener {
    static final String UPDATE_DIALOG_LAYOUT_VERSION = "single-page-v5-background";
    static final int DIALOG_LOGO_DP = 44;
    static final int ACTION_HEIGHT_DP = 48;
    static final int DIALOG_MAX_WIDTH_DP = 420;
    private final Activity activity;
    private final Context uiContext;
    private final AppUpdateCoordinator coordinator;
    private Dialog dialog;
    private TextView eyebrow, title, version, details, status, progressText, fileSize, releaseDate;
    private ProgressBar progress;
    private Button primary, secondary, close;
    private boolean installerOpenedForReady;
    private final Density density;
    enum Density { COMFORTABLE, COMPACT, EXTRA_COMPACT }

    public AppUpdateDialog(Activity activity) {
        this.activity = activity;
        uiContext = new ContextThemeWrapper(activity, R.style.AutoAiUpdateDialogTheme);
        coordinator = AppUpdateCoordinator.get(activity);
        float heightDp = activity.getResources().getDisplayMetrics().heightPixels / activity.getResources().getDisplayMetrics().density;
        density = densityForHeightDp(heightDp);
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
        boolean directFailure = snapshot.state == AppUpdateCoordinator.State.FAILED
            && coordinator.isDirectUpdateActive();
        boolean visible = (AppUpdateCoordinator.hasPendingUpdate(snapshot.metadata) || directFailure)
            && snapshot.state != AppUpdateCoordinator.State.IDLE
            && snapshot.state != AppUpdateCoordinator.State.INSTALLED;
        if (!visible) {
            if (dialog != null) dialog.dismiss();
            dialog = null;
            return;
        }
        if (dialog == null) create();

        AppUpdateCoordinator.Metadata metadata = snapshot.metadata;
        boolean mandatory = metadata != null && metadata.mandatory;
        boolean metadataAvailable = AppUpdateCoordinator.hasPendingUpdate(metadata);
        eyebrow.setText(mandatory ? "MANDATORY SECURITY UPDATE"
            : metadataAvailable ? "VERSION " + metadata.versionName : "UPDATE ERROR");
        eyebrow.setTextColor(mandatory ? Color.rgb(154, 101, 0) : Color.rgb(21, 91, 159));
        title.setText(mandatory ? "Update Required" : "AutoAI Update");
        version.setText("Current " + BuildConfig.VERSION_NAME + "   to   New "
            + (metadataAvailable ? metadata.versionName : "unavailable"));
        fileSize.setText("Update size: " + (metadataAvailable ? formatSize(metadata.fileSize) : "Unavailable"));
        Date released = parseDate(metadataAvailable ? metadata.releaseDate : null);
        DateFormat dateFormat = density == Density.EXTRA_COMPACT
            ? new SimpleDateFormat("dd MMM yy", Locale.US)
            : DateFormat.getDateInstance(DateFormat.MEDIUM);
        releaseDate.setText("Released: " + (released == null ? "Date unavailable" : dateFormat.format(released)));
        details.setText(metadataAvailable
            ? releaseDetails(metadata, density == Density.COMFORTABLE ? 3 : 2)
            : "- Release details unavailable");
        boolean downloading = snapshot.state == AppUpdateCoordinator.State.DOWNLOADING
            || snapshot.state == AppUpdateCoordinator.State.VERIFYING
            || snapshot.state == AppUpdateCoordinator.State.QUEUED
            || snapshot.state == AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK;
        if (downloading && coordinator.isDownloadBackgrounded(metadata)) {
            if (dialog != null) dialog.dismiss();
            dialog = null;
            return;
        }
        String statusMessage = TextUtils.isEmpty(snapshot.message) ? label(snapshot.state) : snapshot.message;
        status.setText(downloading ? statusMessage + " You may continue in the background." : statusMessage);
        status.setTextColor(snapshot.state == AppUpdateCoordinator.State.FAILED
            ? Color.rgb(180, 35, 24)
            : snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL
                ? Color.rgb(32, 122, 69) : Color.rgb(21, 91, 159));
        progress.setVisibility(downloading ? View.VISIBLE : View.GONE);
        progressText.setVisibility(downloading ? View.VISIBLE : View.GONE);
        if (downloading && snapshot.totalBytes > 0) {
            int percent = (int) Math.min(100, snapshot.downloadedBytes * 100 / snapshot.totalBytes);
            progress.setIndeterminate(false);
            progress.setProgress(percent);
            progressText.setText(formatSize(snapshot.downloadedBytes) + " / "
                + formatSize(snapshot.totalBytes) + "   -   " + percent + "%");
        } else if (downloading) {
            progress.setIndeterminate(true);
            progressText.setText(snapshot.downloadedBytes > 0 ? formatSize(snapshot.downloadedBytes) : "Preparing secure download...");
        }

        boolean primaryEnabled = snapshot.state == AppUpdateCoordinator.State.AVAILABLE
            || snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL
            || snapshot.state == AppUpdateCoordinator.State.INSTALL_PERMISSION_REQUIRED
            || snapshot.state == AppUpdateCoordinator.State.PAUSED_WAITING_FOR_NETWORK
            || snapshot.state == AppUpdateCoordinator.State.FAILED;
        primary.setEnabled(primaryEnabled);
        primary.setAlpha(primaryEnabled ? 1f : 0.65f);
        if (snapshot.state == AppUpdateCoordinator.State.DOWNLOADING && snapshot.totalBytes > 0) {
            primary.setText("Downloading " + Math.min(100, snapshot.downloadedBytes * 100 / snapshot.totalBytes) + "%");
        } else primary.setText(actionForState(snapshot.state));
        primary.setOnClickListener(view -> primary(snapshot));

        if (snapshot.state != AppUpdateCoordinator.State.READY_TO_INSTALL) installerOpenedForReady = false;

        boolean mandatoryFailure = mandatory && snapshot.state == AppUpdateCoordinator.State.FAILED;
        boolean optionalSecondary = !mandatory && (snapshot.state == AppUpdateCoordinator.State.AVAILABLE
            || snapshot.state == AppUpdateCoordinator.State.FAILED);
        secondary.setVisibility(mandatoryFailure || optionalSecondary || downloading ? View.VISIBLE : View.GONE);
        secondary.setText(mandatoryFailure ? "EXIT APP" : downloading ? "CONTINUE IN BACKGROUND" : "LATER");
        secondary.setOnClickListener(view -> {
            if (mandatoryFailure) activity.finishAndRemoveTask();
            else if (downloading) continueInBackground();
            else closeOptional(snapshot);
        });
        close.setVisibility(mandatory ? View.GONE : View.VISIBLE);
        close.setOnClickListener(view -> closeOptional(snapshot));

        dialog.setCancelable(!mandatory);
        dialog.setCanceledOnTouchOutside(!mandatory);
        if (!dialog.isShowing()) {
            dialog.show();
            sizeWindow();
        }
        if (snapshot.state == AppUpdateCoordinator.State.READY_TO_INSTALL
            && coordinator.canInstallPackages() && !installerOpenedForReady) {
            installerOpenedForReady = true;
            activity.getWindow().getDecorView().post(this::openInstaller);
        }
    }

    private void create() {
        android.util.Log.i("AutoAiUpdate", "UPDATE_DIALOG_LAYOUT_VERSION " + UPDATE_DIALOG_LAYOUT_VERSION);
        dialog = new Dialog(activity, R.style.AutoAiUpdateDialogTheme);
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
            attributes.dimAmount = 0.48f;
            window.setAttributes(attributes);
        }
    }

    private View buildCard() {
        LinearLayout card = column();
        int outer = density == Density.COMFORTABLE ? 14 : density == Density.COMPACT ? 10 : 8;
        int headerHeight = density == Density.COMFORTABLE ? 48 : density == Density.COMPACT ? 44 : 40;
        int logoSize = density == Density.COMFORTABLE ? 44 : 40;
        int detailSize = density == Density.COMFORTABLE ? 13 : 12;
        card.setPadding(dp(outer), dp(outer), dp(outer), dp(outer));
        card.setBackground(gradient(new int[]{Color.WHITE, Color.WHITE}, 18, Color.rgb(215, 222, 231)));

        FrameLayout header = new FrameLayout(uiContext);
        header.setClipChildren(true);
        FrameLayout logoFrame = new FrameLayout(uiContext);
        logoFrame.setBackground(gradient(new int[]{Color.rgb(238, 246, 255), Color.rgb(238, 246, 255)}, 13, Color.rgb(183, 206, 229)));
        ImageView logo = new ImageView(uiContext);
        logo.setImageResource(R.mipmap.ic_launcher);
        logo.setContentDescription("AutoAI logo");
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setPadding(dp(4), dp(4), dp(4), dp(4));
        logoFrame.addView(logo, new FrameLayout.LayoutParams(-1, -1));
        header.addView(logoFrame, new FrameLayout.LayoutParams(dp(logoSize), dp(logoSize), Gravity.START | Gravity.CENTER_VERTICAL));
        LinearLayout headings = column();
        title = text("", density == Density.COMFORTABLE ? 17 : density == Density.COMPACT ? 16 : 15, Color.rgb(31, 41, 55));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setSingleLine(true);
        eyebrow = text("", 11, Color.rgb(21, 91, 159));
        eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
        headings.addView(title);
        headings.addView(eyebrow);
        FrameLayout.LayoutParams headingParams = new FrameLayout.LayoutParams(-1, -2, Gravity.CENTER_VERTICAL);
        headingParams.leftMargin = dp(logoSize + 10);
        headingParams.rightMargin = dp(42);
        header.addView(headings, headingParams);
        close = new Button(uiContext);
        close.setText("X");
        close.setContentDescription("Close update dialog");
        close.setTextSize(18);
        close.setTextColor(Color.rgb(31, 41, 55));
        close.setGravity(Gravity.CENTER);
        close.setPadding(0, 0, 0, 0);
        close.setBackground(gradient(new int[]{Color.rgb(248, 250, 252), Color.rgb(248, 250, 252)}, 25, Color.rgb(215, 222, 231)));
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(dp(38), dp(38), Gravity.END | Gravity.CENTER_VERTICAL);
        header.addView(close, closeParams);
        card.addView(header, new LinearLayout.LayoutParams(-1, dp(headerHeight)));

        LinearLayout content = column();
        content.setPadding(0, dp(density == Density.COMFORTABLE ? 8 : 4), 0, 0);

        version = text("", detailSize, Color.rgb(95, 107, 122));
        version.setGravity(Gravity.CENTER_VERTICAL);
        version.setSingleLine(true);
        content.addView(version, new LinearLayout.LayoutParams(-1, dp(32)));

        fileSize = infoRow("", Color.rgb(21, 91, 159));
        releaseDate = infoRow("", Color.rgb(21, 91, 159));
        TextView verified = infoRow("", Color.rgb(32, 122, 69));
        verified.setText("Verified secure build");
        verified.setTextColor(Color.rgb(32, 122, 69));
        content.addView(fileSize, new LinearLayout.LayoutParams(-1, dp(30)));
        content.addView(releaseDate, new LinearLayout.LayoutParams(-1, dp(30)));
        if (density != Density.EXTRA_COMPACT) content.addView(verified, new LinearLayout.LayoutParams(-1, dp(30)));

        TextView whatsNew = text("WHAT'S NEW", 12, Color.rgb(21, 91, 159));
        whatsNew.setTypeface(Typeface.DEFAULT_BOLD);
        whatsNew.setGravity(Gravity.CENTER_VERTICAL);
        content.addView(whatsNew, new LinearLayout.LayoutParams(-1, dp(26)));
        details = text("", detailSize, Color.rgb(31, 41, 55));
        details.setLineSpacing(dp(1), 1f);
        details.setMaxLines(density == Density.COMFORTABLE ? 3 : 2);
        details.setEllipsize(TextUtils.TruncateAt.END);
        content.addView(details, new LinearLayout.LayoutParams(-1, dp(density == Density.COMFORTABLE ? 58 : 42)));
        card.addView(content, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout footer = column();
        footer.setPadding(0, dp(4), 0, 0);
        status = text("", detailSize, Color.rgb(21, 91, 159));
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setMaxLines(2);
        status.setEllipsize(TextUtils.TruncateAt.END);
        footer.addView(status, new LinearLayout.LayoutParams(-1, dp(34)));
        progress = new ProgressBar(uiContext, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        footer.addView(progress, new LinearLayout.LayoutParams(-1, dp(6)));
        progressText = text("", 12, Color.rgb(95, 107, 122));
        progressText.setSingleLine(true);
        footer.addView(progressText, new LinearLayout.LayoutParams(-1, dp(24)));

        primary = new Button(uiContext);
        primary.setTextColor(Color.WHITE);
        primary.setContentDescription("Update action");
        primary.setAllCaps(false);
        primary.setTextSize(14);
        primary.setTypeface(Typeface.DEFAULT_BOLD);
        primary.setBackground(gradient(new int[]{Color.rgb(21, 91, 159), Color.rgb(21, 91, 159)}, 15, Color.TRANSPARENT));

        secondary = new Button(uiContext);
        secondary.setTextColor(Color.rgb(31, 41, 55));
        secondary.setContentDescription("Update secondary action");
        secondary.setAllCaps(false);
        secondary.setTextSize(13);
        secondary.setBackground(gradient(new int[]{Color.rgb(248, 250, 252), Color.rgb(248, 250, 252)}, 14, Color.rgb(183, 206, 229)));
        if (density == Density.EXTRA_COMPACT) {
            LinearLayout actions = new LinearLayout(uiContext);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            actions.setBackground(null);
            LinearLayout.LayoutParams secondaryParams = new LinearLayout.LayoutParams(0, dp(ACTION_HEIGHT_DP), 1f);
            secondaryParams.rightMargin = dp(5);
            actions.addView(secondary, secondaryParams);
            LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(0, dp(ACTION_HEIGHT_DP), 1f);
            actions.addView(primary, primaryParams);
            LinearLayout.LayoutParams actionRowParams = new LinearLayout.LayoutParams(-1, dp(ACTION_HEIGHT_DP));
            actionRowParams.topMargin = dp(4);
            footer.addView(actions, actionRowParams);
        } else {
            LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-1, dp(ACTION_HEIGHT_DP));
            primaryParams.topMargin = dp(4);
            footer.addView(primary, primaryParams);
            LinearLayout.LayoutParams secondaryParams = new LinearLayout.LayoutParams(-1, dp(ACTION_HEIGHT_DP));
            secondaryParams.topMargin = dp(3);
            footer.addView(secondary, secondaryParams);
        }
        card.addView(footer, new LinearLayout.LayoutParams(-1, -2));
        ViewCompat.setOnApplyWindowInsetsListener(card, (view, insets) -> {
            int navigationBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            footer.setPadding(0, dp(2), 0, Math.max(dp(2), navigationBottom));
            return insets;
        });
        ViewCompat.requestApplyInsets(card);
        return card;
    }

    private void sizeWindow() {
        Window window = dialog.getWindow();
        if (window == null) return;
        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        int width = Math.min(screenWidth - dp(24), dp(DIALOG_MAX_WIDTH_DP));
        window.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        window.setGravity(Gravity.CENTER);
    }

    private String releaseDetails(AppUpdateCoordinator.Metadata metadata, int limit) {
        String notes = metadata.changelog == null || metadata.changelog.trim().isEmpty()
            ? "Release notes unavailable"
            : metadata.changelog.trim();
        String[] lines = notes.split("[\\r\\n]+");
        StringBuilder bullets = new StringBuilder();
        for (String line : lines) {
            if (limit-- <= 0) break;
            String clean = line.trim().replaceFirst("^[*\\-]+\\s*", "");
            if (!clean.isEmpty()) {
                if (bullets.length() > 0) bullets.append('\n');
                bullets.append("- ").append(clean);
            }
        }
        return bullets.length() == 0 ? "- Performance and security improvements" : bullets.toString();
    }

    private void primary(AppUpdateCoordinator.Snapshot snapshot) {
        switch (snapshot.state) {
            case AVAILABLE:
            case PAUSED_WAITING_FOR_NETWORK:
                coordinator.downloadOrCheck();
                break;
            case FAILED:
                if (AppUpdateCoordinator.hasPendingUpdate(snapshot.metadata)) coordinator.downloadOrCheck();
                else coordinator.startDirectUpdate();
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

    static String actionForState(AppUpdateCoordinator.State state) {
        switch (state) {
            case AVAILABLE: return "Update Now";
            case READY_TO_INSTALL: return "Install Now";
            case INSTALL_PERMISSION_REQUIRED: return "Allow Installation";
            case FAILED: return "Retry";
            case CHECKING: return "Checking...";
            case QUEUED: return "Preparing download...";
            case DOWNLOADING: return "Downloading...";
            case PAUSED_WAITING_FOR_NETWORK: return "Retry";
            case VERIFYING: return "Verifying update...";
            case OPENING_INSTALLER: return "Opening installer...";
            default: return "Update Now";
        }
    }

    private String label(AppUpdateCoordinator.State state) {
        return state.name().toLowerCase(Locale.US).replace('_', ' ');
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(uiContext);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackground(null);
        return layout;
    }

    private void closeOptional(AppUpdateCoordinator.Snapshot snapshot) {
        if (AppUpdateCoordinator.isDownloadInProgress(snapshot.state)) {
            continueInBackground();
            return;
        }
        if (AppUpdateCoordinator.hasPendingUpdate(snapshot.metadata)) {
            coordinator.dismissOptional();
            return;
        }
        if (dialog != null) dialog.dismiss();
        dialog = null;
    }

    private void continueInBackground() {
        coordinator.continueInBackground();
        if (dialog != null) dialog.dismiss();
        dialog = null;
        android.widget.Toast.makeText(activity, "Update download continues in the background.", android.widget.Toast.LENGTH_SHORT).show();
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(uiContext);
        view.setBackground(null);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private TextView infoRow(String icon, int color) {
        TextView row = text(icon, 14, color);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(5), dp(4), dp(2));
        return row;
    }

    private View divider() {
        View view = new View(activity);
        view.setBackgroundColor(Color.rgb(42, 67, 108));
        return view;
    }

    private static Date parseDate(String value) {
        if (value == null || value.trim().isEmpty()) return null;
        String[] patterns = {"yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX", "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'"};
        for (String pattern : patterns) try {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
            if (pattern.endsWith("'Z'")) format.setTimeZone(TimeZone.getTimeZone("UTC"));
            format.setLenient(false);
            return format.parse(value);
        } catch (Exception ignored) { }
        return null;
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

    static Density densityForHeightDp(float heightDp) {
        return heightDp >= 720 ? Density.COMFORTABLE : heightDp >= 600 ? Density.COMPACT : Density.EXTRA_COMPACT;
    }

}
