package com.autoai.app;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.BatteryManager;
import android.provider.Settings;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "AutoAiServiceCapabilities",
    permissions = @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
)
public final class AutoAiServiceCapabilitiesPlugin extends Plugin {
    private static final String PREFS = "auto_ai_form_service_permissions";
    private static final String CAMERA_PROMPTED = "camera_prompted";
    private PluginCall pendingBiometricCall;

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        NativeCameraState camera = cameraState();
        result.put("platform", "android");
        result.put("camera", camera == NativeCameraState.GRANTED ? "SUPPORTED" : "USER_PERMISSION_REQUIRED");
        result.put("cameraPermission", camera.name());
        result.put("documentPicker", "SUPPORTED");
        result.put("biometric", biometricAvailable() ? "SUPPORTED" : "UNSUPPORTED");
        result.put("customTabs", "SUPPORTED");
        result.put("network", networkState());
        BatteryManager battery = (BatteryManager) getContext().getSystemService(Context.BATTERY_SERVICE);
        int percent = battery == null ? -1 : battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
        result.put("batteryPercent", percent >= 0 && percent <= 100 ? percent : null);
        call.resolve(result);
    }

    @PluginMethod
    public void requestCameraPermission(PluginCall call) {
        NativeCameraState current = cameraState();
        if (current == NativeCameraState.GRANTED || current == NativeCameraState.PERMANENTLY_DENIED) {
            resolvePermission(call, current);
            return;
        }
        preferences().edit().putBoolean(CAMERA_PROMPTED, true).apply();
        requestPermissionForAlias("camera", call, "cameraPermissionResult");
    }

    @PermissionCallback
    private void cameraPermissionResult(PluginCall call) {
        resolvePermission(call, cameraState());
    }

    @PluginMethod
    public void openPortal(PluginCall call) {
        String url = call.getString("url", "");
        String officialOrigin = call.getString("officialOrigin", "");
        if (!ServicePortalPolicy.isAllowed(url, officialOrigin)) {
            call.reject("Portal destination failed verified-origin policy.", "BLOCKED_BY_POLICY");
            return;
        }
        try {
            CustomTabsIntent customTab = new CustomTabsIntent.Builder()
                .setShowTitle(true)
                .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                .build();
            customTab.launchUrl(getContext(), Uri.parse(url));
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("No secure browser is available for the official portal.", "EXTERNAL_APP_REQUIRED", error);
        }
    }

    @PluginMethod
    public void confirmHighRisk(PluginCall call) {
        if (pendingBiometricCall != null) {
            call.reject("Another device confirmation is already active.", "CONFIRMATION_IN_PROGRESS");
            return;
        }
        Activity activity = getActivity();
        if (!(activity instanceof FragmentActivity) || !biometricAvailable()) {
            JSObject result = new JSObject();
            result.put("confirmed", false);
            result.put("method", "unavailable");
            call.resolve(result);
            return;
        }
        pendingBiometricCall = call;
        FragmentActivity fragmentActivity = (FragmentActivity) activity;
        int authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG
            | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(call.getString("title", "Confirm application"))
            .setSubtitle(call.getString("subtitle", "Confirm this high-risk action on your device"))
            .setAllowedAuthenticators(authenticators)
            .setConfirmationRequired(true)
            .build();
        fragmentActivity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                fragmentActivity,
                ContextCompat.getMainExecutor(fragmentActivity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult authenticationResult) {
                        super.onAuthenticationSucceeded(authenticationResult);
                        PluginCall active = pendingBiometricCall;
                        pendingBiometricCall = null;
                        if (active == null) return;
                        JSObject result = new JSObject();
                        result.put("confirmed", true);
                        result.put("method", "device_credential_or_biometric");
                        active.resolve(result);
                    }

                    @Override public void onAuthenticationError(int errorCode, CharSequence errorText) {
                        super.onAuthenticationError(errorCode, errorText);
                        PluginCall active = pendingBiometricCall;
                        pendingBiometricCall = null;
                        if (active == null) return;
                        JSObject result = new JSObject();
                        result.put("confirmed", false);
                        result.put("method", "cancelled");
                        active.resolve(result);
                    }
                }
            );
            prompt.authenticate(info);
        });
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Android app settings could not be opened.", "UNAVAILABLE", error);
        }
    }

    private boolean biometricAvailable() {
        int result = BiometricManager.from(getContext()).canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
        );
        return result == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private String networkState() {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "UNKNOWN";
        NetworkCapabilities capabilities = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) ? "ONLINE" : "OFFLINE";
    }

    private NativeCameraState cameraState() {
        if (getContext().checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            || getPermissionState("camera") == PermissionState.GRANTED) return NativeCameraState.GRANTED;
        boolean prompted = preferences().getBoolean(CAMERA_PROMPTED, false);
        Activity activity = getActivity();
        if (prompted && activity != null && !activity.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            return NativeCameraState.PERMANENTLY_DENIED;
        }
        return NativeCameraState.DENIED;
    }

    private void resolvePermission(PluginCall call, NativeCameraState state) {
        JSObject result = new JSObject();
        result.put("status", state.name());
        call.resolve(result);
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private enum NativeCameraState { GRANTED, DENIED, PERMANENTLY_DENIED }
}
