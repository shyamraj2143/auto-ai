package com.autoai.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "AutoAiSecureStorage")
public class AutoAiSecureStoragePlugin extends Plugin {
    private static final String PREFS_NAME = "auto_ai_secure_storage";
    private static final String KEY_ALIAS = "auto_ai_secure_storage_key";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_LENGTH_BITS = 128;

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.trim().isEmpty()) {
            call.reject("Storage key is required.");
            return;
        }
        try {
            JSObject result = new JSObject();
            result.put("value", readStoredValue(getContext(), key));
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Unable to read secure value.", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || key.trim().isEmpty() || value == null) {
            call.reject("Storage key and value are required.");
            return;
        }
        try {
            writeStoredValue(getContext(), key, value);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Unable to save secure value.", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null || key.trim().isEmpty()) {
            call.reject("Storage key is required.");
            return;
        }
        removeStoredValue(getContext(), key);
        call.resolve();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static String readStoredValue(Context context, String key) {
        if (context == null || key == null || key.trim().isEmpty()) return null;
        try {
            String encrypted = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(key, null);
            return encrypted == null ? null : decrypt(encrypted);
        } catch (Exception ignored) {
            return null;
        }
    }

    public static void writeStoredValue(Context context, String key, String value) {
        if (context == null || key == null || key.trim().isEmpty() || value == null) {
            throw new IllegalArgumentException("Storage key and value are required.");
        }
        try {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(key, encrypt(value))
                .commit();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to save secure value.", error);
        }
    }

    public static void removeStoredValue(Context context, String key) {
        if (context == null || key == null || key.trim().isEmpty()) return;
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().remove(key).commit();
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String payload = Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        return iv + ":" + payload;
    }

    private static String decrypt(String encrypted) throws Exception {
        String[] parts = encrypted.split(":", 2);
        if (parts.length != 2) throw new IllegalArgumentException("Invalid encrypted value.");
        byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
        byte[] payload = Base64.decode(parts[1], Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
        return new String(cipher.doFinal(payload), StandardCharsets.UTF_8);
    }

    private static SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        keyGenerator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return keyGenerator.generateKey();
    }
}
