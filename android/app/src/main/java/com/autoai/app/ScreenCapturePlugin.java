package com.autoai.app;

import android.app.Activity;
import android.content.ComponentCallbacks;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Build;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.WindowMetrics;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin {
    private final AtomicBoolean capturing = new AtomicBoolean(false);
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private int width;
    private int height;
    private int density;
    private int maxLongEdge = 960;
    private int jpegQuality = 62;
    private long frameIntervalMs = 150;
    private long lastFrameAtMs;
    private ComponentCallbacks configurationCallbacks;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        call.resolve(result);
    }

    @PluginMethod
    public void startCapture(PluginCall call) {
        if (capturing.get()) {
            call.resolve();
            return;
        }
        maxLongEdge = Math.max(720, Math.min(call.getInt("maxLongEdge", 1920), 2400));
        jpegQuality = Math.max(40, Math.min(call.getInt("jpegQuality", 62), 82));
        int frameRate = Math.max(5, Math.min(call.getInt("frameRate", 8), 15));
        frameIntervalMs = Math.max(66, 1000L / frameRate);
        MediaProjectionManager manager = projectionManager();
        if (manager == null) {
            call.reject("Screen capture is unavailable on this device.");
            return;
        }
        startActivityForResult(call, manager.createScreenCaptureIntent(), "screenCapturePermissionResult");
    }

    @ActivityCallback
    private void screenCapturePermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            ScreenCaptureForegroundService.stop(getContext());
            call.reject("Screen sharing permission was cancelled.");
            return;
        }
        try {
            MediaProjectionManager manager = projectionManager();
            if (manager == null) {
                call.reject("Screen capture is unavailable on this device.");
                return;
            }
            ScreenCaptureForegroundService.start(getContext());
            mediaProjection = manager.getMediaProjection(result.getResultCode(), result.getData());
            if (mediaProjection == null) {
                ScreenCaptureForegroundService.stop(getContext());
                call.reject("Screen sharing permission failed.");
                return;
            }
            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    stopInternal(true);
                }

                @Override
                public void onCapturedContentResize(int nextWidth, int nextHeight) {
                    if (nextWidth > 0 && nextHeight > 0) {
                        resizeCapture(nextWidth, nextHeight);
                    }
                }
            }, new Handler(getContext().getMainLooper()));
            startReader();
            registerConfigurationFallback();
            capturing.set(true);
            notifyCaptureState("captureStarted");
            call.resolve();
        } catch (RuntimeException error) {
            stopInternal(false);
            call.reject("Screen capture failed to start.", error);
        }
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        stopInternal(false);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal(false);
        super.handleOnDestroy();
    }

    private MediaProjectionManager projectionManager() {
        return (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    }

    private void startReader() {
        DisplayBounds bounds = currentDisplayBounds();
        width = bounds.width;
        height = bounds.height;
        density = bounds.density;
        captureThread = new HandlerThread("auto-ai-screen-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        createProjectionSurface();
    }

    private synchronized void createProjectionSurface() {
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::handleImageAvailable, captureHandler);
        virtualDisplay = mediaProjection.createVirtualDisplay(
            "AutoAI Screen Share",
            width,
            height,
            density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
    }

    private synchronized void resizeCapture(int nextWidth, int nextHeight) {
        if (nextWidth <= 0 || nextHeight <= 0 || mediaProjection == null || captureHandler == null) return;
        if (nextWidth == width && nextHeight == height) return;
        width = nextWidth;
        height = nextHeight;
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        createProjectionSurface();
        JSObject payload = new JSObject();
        payload.put("width", width);
        payload.put("height", height);
        payload.put("density", density);
        notifyListeners("captureResize", payload);
    }

    private void notifyCaptureState(String eventName) {
        JSObject payload = new JSObject();
        payload.put("virtualDisplayWidth", width);
        payload.put("virtualDisplayHeight", height);
        payload.put("density", density);
        payload.put("maxLongEdge", maxLongEdge);
        payload.put("jpegQuality", jpegQuality);
        payload.put("orientation", getContext().getResources().getConfiguration().orientation);
        DisplayBounds bounds = currentDisplayBounds();
        payload.put("displayWidth", bounds.width);
        payload.put("displayHeight", bounds.height);
        payload.put("displayDensity", bounds.density);
        notifyListeners(eventName, payload);
    }

    private DisplayBounds currentDisplayBounds() {
        int nextWidth;
        int nextHeight;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager windowManager = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
            WindowMetrics metrics = windowManager.getMaximumWindowMetrics();
            Rect bounds = metrics.getBounds();
            nextWidth = bounds.width();
            nextHeight = bounds.height();
        } else {
            DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
            nextWidth = metrics.widthPixels;
            nextHeight = metrics.heightPixels;
        }
        DisplayMetrics displayMetrics = getContext().getResources().getDisplayMetrics();
        return new DisplayBounds(Math.max(1, nextWidth), Math.max(1, nextHeight), displayMetrics.densityDpi);
    }

    private void registerConfigurationFallback() {
        if (configurationCallbacks != null) return;
        configurationCallbacks = new ComponentCallbacks() {
            @Override
            public void onConfigurationChanged(Configuration newConfig) {
                DisplayBounds bounds = currentDisplayBounds();
                resizeCapture(bounds.width, bounds.height);
            }

            @Override
            public void onLowMemory() {
                // No-op.
            }
        };
        getContext().registerComponentCallbacks(configurationCallbacks);
    }

    private void unregisterConfigurationFallback() {
        if (configurationCallbacks == null) return;
        getContext().unregisterComponentCallbacks(configurationCallbacks);
        configurationCallbacks = null;
    }

    private void handleImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAtMs < frameIntervalMs) return;
            lastFrameAtMs = now;
            Image.Plane plane = image.getPlanes()[0];
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = rowStride - pixelStride * width;
            Bitmap bitmap = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888);
            ByteBuffer buffer = plane.getBuffer();
            bitmap.copyPixelsFromBuffer(buffer);
            Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, width, height);
            bitmap.recycle();
            Bitmap output = scaleBitmap(cropped);
            if (output != cropped) cropped.recycle();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            output.compress(Bitmap.CompressFormat.JPEG, jpegQuality, bytes);
            JSObject frame = new JSObject();
            frame.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            frame.put("width", output.getWidth());
            frame.put("height", output.getHeight());
            frame.put("timestamp", now);
            output.recycle();
            notifyListeners("frame", frame);
        } catch (RuntimeException error) {
            JSObject payload = new JSObject();
            payload.put("message", "Screen frame capture failed.");
            notifyListeners("captureError", payload);
        } finally {
            if (image != null) image.close();
        }
    }

    private Bitmap scaleBitmap(Bitmap source) {
        int longEdge = Math.max(source.getWidth(), source.getHeight());
        if (longEdge <= maxLongEdge) return source;
        float ratio = maxLongEdge / (float) longEdge;
        int nextWidth = Math.max(1, Math.round(source.getWidth() * ratio));
        int nextHeight = Math.max(1, Math.round(source.getHeight() * ratio));
        return Bitmap.createScaledBitmap(source, nextWidth, nextHeight, true);
    }

    private synchronized void stopInternal(boolean projectionStopped) {
        if (!capturing.getAndSet(false) && mediaProjection == null && virtualDisplay == null && imageReader == null) return;
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        MediaProjection projection = mediaProjection;
        mediaProjection = null;
        if (projection != null && !projectionStopped) {
            projection.stop();
        }
        if (captureThread != null) {
            captureThread.quitSafely();
            captureThread = null;
            captureHandler = null;
        }
        unregisterConfigurationFallback();
        ScreenCaptureForegroundService.stop(getContext());
        notifyListeners("captureEnded", new JSObject());
    }

    private static class DisplayBounds {
        final int width;
        final int height;
        final int density;

        DisplayBounds(int width, int height, int density) {
            this.width = width;
            this.height = height;
            this.density = density;
        }
    }
}
