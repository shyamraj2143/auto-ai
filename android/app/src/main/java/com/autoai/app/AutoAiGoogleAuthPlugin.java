package com.autoai.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "AutoAiGoogleAuth")
public class AutoAiGoogleAuthPlugin extends Plugin {
    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = resolveWebClientId(call.getString("clientId"));
        if (clientId == null || clientId.trim().isEmpty()) {
            call.reject("Google Sign-In is not configured for this app build.");
            return;
        }
        GoogleSignInClient client = GoogleSignIn.getClient(
            getActivity(),
            new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(clientId)
                .requestEmail()
                .requestProfile()
                .build()
        );
        startActivityForResult(call, client.getSignInIntent(), "handleSignInResult");
    }

    @ActivityCallback
    private void handleSignInResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null) {
            call.reject("Google Sign-In was cancelled.");
            return;
        }
        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(data);
        try {
            GoogleSignInAccount account = task.getResult(ApiException.class);
            String idToken = account.getIdToken();
            if (idToken == null || idToken.isEmpty()) {
                call.reject("Google did not return an ID token.");
                return;
            }
            JSObject payload = new JSObject();
            payload.put("idToken", idToken);
            payload.put("email", account.getEmail());
            payload.put("name", account.getDisplayName());
            Uri photoUrl = account.getPhotoUrl();
            payload.put("picture", photoUrl == null ? null : photoUrl.toString());
            call.resolve(payload);
        } catch (ApiException error) {
            call.reject(googleSignInErrorMessage(error.getStatusCode()));
        }
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        GoogleSignIn.getClient(getActivity(), GoogleSignInOptions.DEFAULT_SIGN_IN)
            .signOut()
            .addOnCompleteListener(task -> call.resolve());
    }

    private String resolveWebClientId(String requestedClientId) {
        String googleServicesClientId = readStringResource("default_web_client_id");
        if (isValidClientId(googleServicesClientId)) {
            return googleServicesClientId;
        }

        String buildClientId = readStringResource("auto_ai_google_web_client_id");
        if (isValidClientId(buildClientId)) {
            return buildClientId;
        }

        return isValidClientId(requestedClientId) ? requestedClientId.trim() : null;
    }

    private String readStringResource(String name) {
        int id = getContext().getResources().getIdentifier(name, "string", getContext().getPackageName());
        if (id == 0) {
            return null;
        }
        String value = getContext().getString(id);
        return value == null ? null : value.trim();
    }

    private boolean isValidClientId(String value) {
        return value != null && value.trim().endsWith(".apps.googleusercontent.com");
    }

    private String googleSignInErrorMessage(int statusCode) {
        if (statusCode == 7) {
            return "Google Sign-In could not reach Google Play services. Check mobile data or Wi-Fi, disable VPN/private DNS temporarily, update Google Play services, and try again.";
        }
        if (statusCode == 8) {
            return "Google Sign-In is temporarily unavailable. Please try again.";
        }
        if (statusCode == 12501) {
            return "Google Sign-In was cancelled.";
        }
        if (statusCode == 10) {
            return "Google Sign-In is not configured for this Android app. Add package "
                + getContext().getPackageName()
                + " with SHA-1 "
                + signingFingerprint("SHA-1")
                + " and SHA-256 "
                + signingFingerprint("SHA-256")
                + " in Google Cloud/Firebase, then rebuild the app with the matching Web client ID.";
        }
        return "Google Sign-In failed with status " + statusCode + ".";
    }

    private String signingFingerprint(String algorithm) {
        try {
            PackageInfo packageInfo;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo = getContext().getPackageManager().getPackageInfo(
                    getContext().getPackageName(),
                    PackageManager.GET_SIGNING_CERTIFICATES
                );
                if (packageInfo.signingInfo == null) {
                    return "unavailable";
                }
                Signature[] signatures = packageInfo.signingInfo.hasMultipleSigners()
                    ? packageInfo.signingInfo.getApkContentsSigners()
                    : packageInfo.signingInfo.getSigningCertificateHistory();
                return formatFingerprint(signatures, algorithm);
            }

            packageInfo = getContext().getPackageManager().getPackageInfo(
                getContext().getPackageName(),
                PackageManager.GET_SIGNATURES
            );
            return formatFingerprint(packageInfo.signatures, algorithm);
        } catch (Exception ignored) {
            return "unavailable";
        }
    }

    private String formatFingerprint(Signature[] signatures, String algorithm) throws Exception {
        if (signatures == null || signatures.length == 0) {
            return "unavailable";
        }
        MessageDigest digest = MessageDigest.getInstance(algorithm);
        List<String> values = new ArrayList<>();
        for (Signature signature : signatures) {
            digest.reset();
            byte[] hash = digest.digest(signature.toByteArray());
            StringBuilder builder = new StringBuilder();
            for (byte value : hash) {
                if (builder.length() > 0) {
                    builder.append(':');
                }
                builder.append(String.format(Locale.US, "%02X", value));
            }
            values.add(builder.toString());
        }
        return String.join(", ", values);
    }
}
