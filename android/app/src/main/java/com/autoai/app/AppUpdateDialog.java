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
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Locale;
import java.util.Date;
import java.text.DateFormat;
import java.text.SimpleDateFormat;
import java.util.TimeZone;

/** Compact native update surface. Durable state remains in AppUpdateCoordinator. */
public final class AppUpdateDialog implements AppUpdateCoordinator.Listener {
    private final Activity activity;
    private final AppUpdateCoordinator coordinator;
    private Dialog dialog;
    private TextView eyebrow, title, version, details, status, progressText, fileSize, releaseDate, releaseTime, viewMore;
    private ProgressBar progress;
    private Button primary, secondary, close;

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
        eyebrow.setText(metadata.mandatory ? "MANDATORY SECURITY UPDATE" : "VERSION " + metadata.versionName);
        eyebrow.setTextColor(metadata.mandatory ? Color.rgb(255, 181, 71) : Color.rgb(104, 227, 255));
        title.setText(metadata.mandatory ? "Update Required" : "New AutoAI Update");
        version.setText("Current " + BuildConfig.VERSION_NAME + "   →   New " + metadata.versionName);
        fileSize.setText("▣     " + formatSize(metadata.fileSize));
        Date released = parseDate(metadata.releaseDate);
        releaseDate.setText("◷     " + (released == null ? "Release date unavailable" : DateFormat.getDateInstance(DateFormat.MEDIUM).format(released)));
        releaseTime.setText("◷     " + (released == null ? "Release time unavailable" : DateFormat.getTimeInstance(DateFormat.SHORT).format(released)));
        details.setText(releaseDetails(metadata));
        viewMore.setVisibility(details.length() > 150 ? View.VISIBLE : View.GONE);
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
        secondary.setText(mandatoryFailure ? "EXIT APP" : downloading ? "CANCEL DOWNLOAD" : "LATER");
        secondary.setOnClickListener(view -> {
            if (mandatoryFailure) activity.finishAndRemoveTask();
            else if (downloading) coordinator.cancelOptional();
            else coordinator.dismissOptional();
        });
        close.setVisibility(metadata.mandatory ? View.GONE : View.VISIBLE);
        close.setOnClickListener(view -> coordinator.dismissOptional());

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
        card.setPadding(dp(15), dp(12), dp(15), dp(12));
        card.setBackground(gradient(new int[]{Color.rgb(25, 18, 61), Color.rgb(7, 24, 52), Color.rgb(3, 42, 51)}, 22, Color.rgb(102, 79, 255)));

        // Fixed compact header: one bounded logo, one title and one version badge.
        FrameLayout header = new FrameLayout(activity);
        header.setClipChildren(true);
        FrameLayout logoFrame = new FrameLayout(activity);
        logoFrame.setClipChildren(true);
        logoFrame.setBackground(gradient(new int[]{Color.rgb(49, 29, 103), Color.rgb(5, 69, 85)}, 18, Color.rgb(48, 231, 255)));
        ImageView logo = new ImageView(activity);
        logo.setImageResource(R.mipmap.ic_launcher_foreground);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        logo.setAdjustViewBounds(false);
        logo.setPadding(dp(4), dp(4), dp(4), dp(4));
        logoFrame.addView(logo, new FrameLayout.LayoutParams(-1, -1));
        FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER);
        header.addView(logoFrame, logoParams);
        close = new Button(activity);
        close.setText("×");
        close.setTextSize(24);
        close.setTextColor(Color.WHITE);
        close.setGravity(Gravity.CENTER);
        close.setPadding(0, 0, 0, dp(3));
        close.setBackground(gradient(new int[]{Color.rgb(24, 39, 82), Color.rgb(8, 23, 53)}, 25, Color.rgb(77, 105, 172)));
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.END | Gravity.TOP);
        header.addView(close, closeParams);
        card.addView(header, new LinearLayout.LayoutParams(-1, dp(58)));

        eyebrow = text("", 11, Color.rgb(104, 227, 255));
        eyebrow.setTypeface(Typeface.DEFAULT_BOLD);
        eyebrow.setLetterSpacing(0.08f);
        eyebrow.setGravity(Gravity.CENTER);
        title = text("", 21, Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(5), 0, dp(2));
        card.addView(title);
        card.addView(eyebrow);

        // Only the center region scrolls. The action footer below always remains visible.
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        LinearLayout content = column();
        content.setPadding(0, dp(3), 0, dp(4));

        version = text("", 14, Color.rgb(195, 210, 243));
        version.setGravity(Gravity.CENTER);
        version.setPadding(dp(8), dp(5), dp(8), dp(7));
        LinearLayout.LayoutParams versionParams = new LinearLayout.LayoutParams(-1, -2);
        content.addView(version, versionParams);

        View dividerTop = divider();
        content.addView(dividerTop, new LinearLayout.LayoutParams(-1, dp(1)));
        fileSize = infoRow("▣", Color.rgb(59, 226, 255));
        releaseDate = infoRow("◷", Color.rgb(79, 205, 255));
        releaseTime = infoRow("◷", Color.rgb(79, 205, 255));
        TextView verified = infoRow("✓", Color.rgb(82, 230, 127));
        verified.setText("✓     Verified secure build");
        verified.setTextColor(Color.rgb(89, 232, 126));
        content.addView(fileSize);
        content.addView(releaseDate);
        content.addView(releaseTime);
        content.addView(verified);
        View dividerBottom = divider();
        LinearLayout.LayoutParams dividerParams = new LinearLayout.LayoutParams(-1, dp(1));
        dividerParams.topMargin = dp(4);
        content.addView(dividerBottom, dividerParams);

        TextView whatsNew = text("WHAT’S NEW", 15, Color.rgb(199, 92, 255));
        whatsNew.setTypeface(Typeface.DEFAULT_BOLD);
        whatsNew.setPadding(0, dp(8), 0, 0);
        content.addView(whatsNew);
        details = text("", 14, Color.rgb(224, 229, 247));
        details.setLineSpacing(dp(3), 1f);
        details.setPadding(dp(2), dp(6), dp(2), dp(5));
        details.setMaxLines(3);
        details.setEllipsize(TextUtils.TruncateAt.END);
        content.addView(details, new LinearLayout.LayoutParams(-1, -2));
        viewMore = text("View More", 12, Color.rgb(111, 207, 255));
        viewMore.setTypeface(Typeface.DEFAULT_BOLD);
        viewMore.setPadding(0, dp(1), 0, dp(3));
        viewMore.setOnClickListener(view -> {
            boolean collapsed = details.getMaxLines() == 3;
            details.setMaxLines(collapsed ? Integer.MAX_VALUE : 3);
            details.setEllipsize(collapsed ? null : TextUtils.TruncateAt.END);
            viewMore.setText(collapsed ? "View Less" : "View More");
        });
        content.addView(viewMore);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        LinearLayout.LayoutParams scrollParams = new LinearLayout.LayoutParams(-1, 0, 1f);
        card.addView(scroll, scrollParams);

        LinearLayout footer = column();
        footer.setPadding(0, dp(3), 0, 0);
        status = text("", 13, Color.rgb(112, 216, 255));
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setPadding(0, dp(3), 0, dp(4));
        footer.addView(status);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        footer.addView(progress, new LinearLayout.LayoutParams(-1, dp(6)));
        progressText = text("", 12, Color.rgb(159, 205, 255));
        progressText.setPadding(0, dp(3), 0, 0);
        footer.addView(progressText);

        primary = new Button(activity);
        primary.setTextColor(Color.WHITE);
        primary.setAllCaps(false);
        primary.setTextSize(16);
        primary.setTypeface(Typeface.DEFAULT_BOLD);
        primary.setBackground(gradient(new int[]{Color.rgb(147, 58, 255), Color.rgb(40, 111, 247), Color.rgb(0, 203, 235)}, 15, Color.TRANSPARENT));
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(-1, dp(48));
        primaryParams.topMargin = dp(7);
        footer.addView(primary, primaryParams);

        secondary = new Button(activity);
        secondary.setTextColor(Color.rgb(203, 213, 243));
        secondary.setAllCaps(false);
        secondary.setTextSize(14);
        secondary.setBackground(gradient(new int[]{Color.rgb(11, 25, 55), Color.rgb(9, 20, 45)}, 14, Color.rgb(97, 132, 203)));
        LinearLayout.LayoutParams secondaryParams = new LinearLayout.LayoutParams(-1, dp(38));
        secondaryParams.topMargin = dp(5);
        footer.addView(secondary, secondaryParams);
        card.addView(footer, new LinearLayout.LayoutParams(-1, -2));
        return card;
    }

    private void sizeWindow() {
        Window window = dialog.getWindow();
        if (window == null) return;
        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        int screenHeight = activity.getResources().getDisplayMetrics().heightPixels;
        int width = Math.min(screenWidth - dp(32), dp(360));
        int height = Math.min(screenHeight - dp(48), dp(560));
        window.setLayout(width, height);
        window.setGravity(Gravity.CENTER);
    }

    private String releaseDetails(AppUpdateCoordinator.Metadata metadata) {
        String notes = metadata.changelog == null || metadata.changelog.trim().isEmpty()
            ? "Release notes unavailable"
            : metadata.changelog.trim();
        String[] lines = notes.split("[\\r\\n]+");
        StringBuilder bullets = new StringBuilder();
        for (String line : lines) {
            String clean = line.trim().replaceFirst("^[•\\-*]+\\s*", "");
            if (!clean.isEmpty()) {
                if (bullets.length() > 0) bullets.append('\n');
                bullets.append("•  ").append(clean);
            }
        }
        return bullets.length() == 0 ? "•  Performance and security improvements" : bullets.toString();
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
            case AVAILABLE: return "⇩   UPDATE NOW";
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

    private TextView infoRow(String icon, int color) {
        TextView row = text(icon, 14, color);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(8), dp(6), dp(3));
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
}
