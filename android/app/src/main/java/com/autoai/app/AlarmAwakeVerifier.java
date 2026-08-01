package com.autoai.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class AlarmAwakeVerifier {
    interface LocalCallback { void complete(LocalResult result); }
    interface OnlineCallback { void complete(OnlineResult result); }

    static final class LocalResult {
        final boolean awake;
        final double confidence;
        final String reason;
        final double leftEyeOpen;
        final double rightEyeOpen;
        final double faceRatio;

        LocalResult(
            boolean awake,
            double confidence,
            String reason,
            double leftEyeOpen,
            double rightEyeOpen,
            double faceRatio
        ) {
            this.awake = awake;
            this.confidence = confidence;
            this.reason = reason;
            this.leftEyeOpen = leftEyeOpen;
            this.rightEyeOpen = rightEyeOpen;
            this.faceRatio = faceRatio;
        }
    }

    static final class OnlineResult {
        final boolean available;
        final boolean awake;
        final double confidence;
        final String reason;
        final String model;

        OnlineResult(boolean available, boolean awake, double confidence, String reason, String model) {
            this.available = available;
            this.awake = awake;
            this.confidence = confidence;
            this.reason = reason;
            this.model = model;
        }

        static OnlineResult unavailable(String reason) {
            return new OnlineResult(false, false, 0d, reason, "offline-on-device");
        }
    }

    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .writeTimeout(8, TimeUnit.SECONDS)
        .callTimeout(11, TimeUnit.SECONDS)
        .build();

    private AlarmAwakeVerifier() {}

    static void verifyLocal(Context context, File photo, LocalCallback callback) {
        final InputImage image;
        try {
            image = InputImage.fromFilePath(context.getApplicationContext(), Uri.fromFile(photo));
        } catch (IOException failure) {
            callback.complete(failed("The photo could not be read. Please capture again."));
            return;
        }
        FaceDetectorOptions options = new FaceDetectorOptions.Builder()
            .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
            .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
            .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
            .setMinFaceSize(.16f)
            .build();
        FaceDetector detector = FaceDetection.getClient(options);
        detector.process(image)
            .addOnSuccessListener(faces -> callback.complete(evaluate(image, faces)))
            .addOnFailureListener(error -> callback.complete(failed("Face check failed. Keep your face in the frame and try again.")))
            .addOnCompleteListener(ignored -> detector.close());
    }

    static void verifyOnline(Context context, String alarmId, File photo, OnlineCallback callback) {
        if (!hasValidatedInternet(context)) {
            callback.complete(OnlineResult.unavailable("No internet; bundled on-device verification was used."));
            return;
        }
        String token = AutoAiSecureStoragePlugin.readStoredValue(context, "auto-ai-access-token");
        if (token == null || token.trim().isEmpty()) {
            callback.complete(OnlineResult.unavailable("No active session; bundled on-device verification was used."));
            return;
        }
        String baseUrl = BuildConfig.AUTO_AI_API_BASE_URL == null ? "" : BuildConfig.AUTO_AI_API_BASE_URL.trim();
        while (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0, baseUrl.length() - 1);
        if (baseUrl.isEmpty()) {
            callback.complete(OnlineResult.unavailable("Verification service is not configured."));
            return;
        }
        RequestBody fileBody = RequestBody.create(MediaType.get("image/jpeg"), photo);
        RequestBody multipart = new MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", photo.getName(), fileBody)
            .build();
        Request request = new Request.Builder()
            .url(baseUrl + "/alarms/" + Uri.encode(alarmId) + "/verify-awake")
            .header("Authorization", "Bearer " + token.trim())
            .header("Accept", "application/json")
            .post(multipart)
            .build();
        HTTP.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException error) {
                callback.complete(OnlineResult.unavailable("Groq verification was unreachable; bundled on-device verification was used."));
            }

            @Override public void onResponse(Call call, Response response) {
                try (Response closeable = response) {
                    if (!response.isSuccessful() || response.body() == null) {
                        callback.complete(OnlineResult.unavailable("Groq verification was unavailable; bundled on-device verification was used."));
                        return;
                    }
                    JSONObject value = new JSONObject(response.body().string());
                    callback.complete(new OnlineResult(
                        true,
                        value.optBoolean("awake", false),
                        clamp(value.optDouble("confidence", 0d)),
                        clean(value.optString("reason", "Please capture again.")),
                        clean(value.optString("model", "groq-vision"))
                    ));
                } catch (Exception error) {
                    callback.complete(OnlineResult.unavailable("Groq returned an unreadable result; bundled on-device verification was used."));
                }
            }
        });
    }

    private static LocalResult evaluate(InputImage image, List<Face> faces) {
        if (faces == null || faces.isEmpty()) return failed("No face found. Look directly at the front camera.");
        if (faces.size() != 1) return failed("Keep only your face in the frame and capture again.");
        Face face = faces.get(0);
        Float left = face.getLeftEyeOpenProbability();
        Float right = face.getRightEyeOpenProbability();
        if (left == null || right == null) {
            return failed("Look straight at the camera with both eyes clearly visible.");
        }
        double imageArea = Math.max(1d, (double) image.getWidth() * (double) image.getHeight());
        double faceRatio = Math.max(0d, (double) face.getBoundingBox().width() * face.getBoundingBox().height() / imageArea);
        double leftEye = clamp(left);
        double rightEye = clamp(right);
        double eyeScore = (leftEye + rightEye) / 2d;
        double yaw = Math.abs(face.getHeadEulerAngleY());
        double roll = Math.abs(face.getHeadEulerAngleZ());
        double pitch = Math.abs(face.getHeadEulerAngleX());
        boolean centered = yaw <= 24d && roll <= 20d && pitch <= 24d;
        boolean largeEnough = faceRatio >= .075d;
        boolean eyesOpen = leftEye >= .52d && rightEye >= .52d && eyeScore >= .60d;
        double angleScore = clamp(1d - ((yaw / 45d + roll / 40d + pitch / 45d) / 3d));
        double confidence = clamp(eyeScore * .72d + Math.min(1d, faceRatio / .24d) * .18d + angleScore * .10d);
        if (!largeEnough) {
            return new LocalResult(false, confidence, "Move closer so your face fills more of the frame.", leftEye, rightEye, faceRatio);
        }
        if (!centered) {
            return new LocalResult(false, confidence, "Hold your head straight and look directly at the camera.", leftEye, rightEye, faceRatio);
        }
        if (!eyesOpen) {
            return new LocalResult(false, confidence, "Open both eyes and capture again to confirm you are awake.", leftEye, rightEye, faceRatio);
        }
        return new LocalResult(true, confidence, "On-device face and open-eye check passed.", leftEye, rightEye, faceRatio);
    }

    private static LocalResult failed(String reason) {
        return new LocalResult(false, 0d, reason, 0d, 0d, 0d);
    }

    private static boolean hasValidatedInternet(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        return capabilities != null
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private static double clamp(double value) {
        if (!Double.isFinite(value)) return 0d;
        return Math.max(0d, Math.min(1d, value));
    }

    private static String clean(String value) {
        String clean = value == null ? "" : value.trim();
        return clean.length() > 220 ? clean.substring(0, 220) : clean;
    }
}
