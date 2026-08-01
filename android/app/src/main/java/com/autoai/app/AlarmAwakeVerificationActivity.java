package com.autoai.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.UUID;

public final class AlarmAwakeVerificationActivity extends AppCompatActivity {
    private static final int CAMERA_PERMISSION_REQUEST = 8041;

    private String alarmId;
    private PreviewView previewView;
    private TextView statusView;
    private Button captureButton;
    private ImageCapture imageCapture;
    private ProcessCameraProvider cameraProvider;
    private boolean verificationRunning;

    static PendingIntent pendingIntent(Context context, AlarmPayload alarm) {
        Intent intent = new Intent(context, AlarmAwakeVerificationActivity.class)
            .setAction("com.autoai.app.alarm.VERIFY_AWAKE")
            .setData(Uri.parse("autoai://alarm-awake/" + Uri.encode(alarm.alarmId)))
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarm.alarmId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, AlarmPayload.requestCode(alarm.alarmId) + 4, intent, flags);
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
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        alarmId = getIntent().getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        AlarmPayload alarm = AlarmStore.get(this, alarmId);
        if (alarm == null || !alarm.enabled || !"ringing".equals(alarm.status)) {
            finishAndRemoveTask();
            return;
        }
        setContentView(content());
        ensureCamera();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        alarmId = intent.getStringExtra(AlarmScheduler.EXTRA_ALARM_ID);
        ensureCamera();
    }

    private View content() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        previewView = new PreviewView(this);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        root.addView(previewView, new FrameLayout.LayoutParams(-1, -1));

        TextView instruction = new TextView(this);
        instruction.setText("LOOK AT THE CAMERA • KEEP BOTH EYES OPEN");
        instruction.setTextColor(Color.WHITE);
        instruction.setTextSize(11);
        instruction.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        instruction.setGravity(Gravity.CENTER);
        instruction.setLetterSpacing(.08f);
        instruction.setPadding(dp(16), dp(12), dp(16), dp(12));
        instruction.setBackground(rounded(Color.argb(190, 4, 11, 24), Color.argb(120, 255, 177, 91), 18, 1));
        FrameLayout.LayoutParams instructionParams = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        instructionParams.setMargins(dp(18), dp(30), dp(18), 0);
        root.addView(instruction, instructionParams);

        LinearLayout controls = new LinearLayout(this);
        controls.setOrientation(LinearLayout.VERTICAL);
        controls.setGravity(Gravity.CENTER_HORIZONTAL);
        controls.setPadding(dp(18), dp(22), dp(18), dp(26));
        controls.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { Color.TRANSPARENT, Color.argb(210, 1, 7, 17), Color.rgb(1, 7, 17) }));

        statusView = new TextView(this);
        statusView.setText("Starting the front camera…");
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(13);
        statusView.setGravity(Gravity.CENTER);
        statusView.setLineSpacing(0f, 1.15f);
        controls.addView(statusView, new LinearLayout.LayoutParams(-1, -2));

        captureButton = new Button(this);
        captureButton.setText("Capture awake photo");
        captureButton.setAllCaps(false);
        captureButton.setTextColor(Color.WHITE);
        captureButton.setTextSize(14);
        captureButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        captureButton.setEnabled(false);
        captureButton.setBackground(rounded(Color.rgb(226, 95, 30), Color.rgb(255, 184, 101), 20, 1));
        captureButton.setOnClickListener(view -> capture());
        LinearLayout.LayoutParams captureParams = new LinearLayout.LayoutParams(-1, dp(58));
        captureParams.topMargin = dp(14);
        controls.addView(captureButton, captureParams);

        FrameLayout.LayoutParams controlsParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        root.addView(controls, controlsParams);
        return root;
    }

    private void ensureCamera() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera();
            return;
        }
        showStatus("Camera access is required to stop this alarm.", false);
        ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION_REQUEST);
    }

    private void startCamera() {
        showStatus("Starting the front camera…", false);
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                cameraProvider = future.get();
                bindCamera(CameraSelector.DEFAULT_FRONT_CAMERA);
            } catch (Exception frontFailure) {
                try { bindCamera(CameraSelector.DEFAULT_BACK_CAMERA); }
                catch (Exception unavailable) { showStatus("Camera is unavailable. Unlock the phone and try again.", false); }
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindCamera(CameraSelector selector) {
        if (cameraProvider == null || isFinishing()) return;
        cameraProvider.unbindAll();
        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());
        imageCapture = new ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .build();
        cameraProvider.bindToLifecycle(this, selector, preview, imageCapture);
        showStatus("Center your face, open both eyes, then capture.", true);
    }

    private void capture() {
        if (verificationRunning) return;
        if (imageCapture == null) {
            ensureCamera();
            return;
        }
        verificationRunning = true;
        showStatus("Capturing a live photo…", false);
        File photo = new File(getCacheDir(), "alarm-awake-" + UUID.randomUUID() + ".jpg");
        ImageCapture.OutputFileOptions output = new ImageCapture.OutputFileOptions.Builder(photo).build();
        imageCapture.takePicture(output, ContextCompat.getMainExecutor(this), new ImageCapture.OnImageSavedCallback() {
            @Override public void onImageSaved(@NonNull ImageCapture.OutputFileResults result) {
                showStatus("Checking your face and open eyes on this device…", false);
                AlarmAwakeVerifier.verifyLocal(AlarmAwakeVerificationActivity.this, photo,
                    local -> runOnUiThread(() -> handleLocalResult(photo, local)));
            }

            @Override public void onError(@NonNull ImageCaptureException error) {
                photo.delete();
                verificationRunning = false;
                showStatus("Photo capture failed. Keep your face visible and try again.", true);
            }
        });
    }

    private void handleLocalResult(File photo, AlarmAwakeVerifier.LocalResult result) {
        if (!result.awake) {
            photo.delete();
            verificationRunning = false;
            showStatus(result.reason, true);
            return;
        }
        showStatus("On-device check passed. Groq Vision is double-checking when internet is available…", false);
        AlarmAwakeVerifier.verifyOnline(this, alarmId, photo, online -> runOnUiThread(() -> {
            photo.delete();
            if (online.available && !online.awake) {
                verificationRunning = false;
                showStatus(online.reason.isEmpty() ? "You do not look fully awake yet. Open both eyes and try again." : online.reason, true);
                return;
            }
            completeVerifiedDismissal(online.available ? "Awake verified by Groq Vision." : "Awake verified offline on this device.");
        }));
    }

    private void completeVerifiedDismissal(String message) {
        showStatus(message, false);
        sendBroadcast(new Intent(this, AlarmActionReceiver.class)
            .setAction(AlarmActionReceiver.ACTION_DISMISS)
            .putExtra(AlarmScheduler.EXTRA_ALARM_ID, alarmId)
            .putExtra(AlarmActionReceiver.EXTRA_AWAKE_VERIFIED, true));
        captureButton.postDelayed(this::finishAndRemoveTask, 550L);
    }

    private void showStatus(String message, boolean enableCapture) {
        if (statusView != null) statusView.setText(message);
        if (captureButton != null) {
            captureButton.setEnabled(enableCapture);
            captureButton.setAlpha(enableCapture ? 1f : .62f);
        }
    }

    @Override public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) startCamera();
        else showStatus("Camera permission is required. The alarm will keep ringing until access is granted and your face is verified.", true);
    }

    @Override public void onBackPressed() {
        // Returning never dismisses the alarm; the ringing screen remains underneath.
        finish();
    }

    @Override protected void onDestroy() {
        if (cameraProvider != null) cameraProvider.unbindAll();
        super.onDestroy();
    }

    private GradientDrawable rounded(int fill, int stroke, int radiusDp, int strokeDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        drawable.setStroke(dp(strokeDp), stroke);
        return drawable;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
