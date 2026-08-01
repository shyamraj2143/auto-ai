package com.autoai.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Read-only WebView bridge to the application-scoped native updater. */
@CapacitorPlugin(name = "AutoAiUpdate")
public final class AutoAiUpdatePlugin extends Plugin implements AppUpdateCoordinator.Listener {
    private AppUpdateCoordinator coordinator;

    @Override public void load() {
        coordinator = AppUpdateCoordinator.get(getContext());
        coordinator.addListener(this);
    }

    @Override protected void handleOnDestroy() {
        if (coordinator != null) coordinator.removeListener(this);
        super.handleOnDestroy();
    }

    @PluginMethod public void getState(PluginCall call) { call.resolve(payload(coordinator.current())); }
    @PluginMethod public void checkForUpdate(PluginCall call) {
        coordinator.check(true);
        call.resolve(payload(coordinator.current()));
    }
    @PluginMethod public void startDirectUpdate(PluginCall call) {
        coordinator.startDirectUpdate();
        call.resolve(payload(coordinator.current()));
    }

    /** Backward-compatible bridge: old callers now start the direct flow, never a dialog. */
    @PluginMethod public void openUpdate(PluginCall call) { startDirectUpdate(call); }

    @Override public void onUpdateChanged(AppUpdateCoordinator.Snapshot snapshot) {
        notifyListeners("stateChanged", payload(snapshot), true);
        notifyListeners("auto-ai-update-state", payload(snapshot), true);
    }

    private JSObject payload(AppUpdateCoordinator.Snapshot snapshot) {
        JSObject out = new JSObject();
        AppUpdateCoordinator.Metadata m = snapshot.metadata;
        out.put("installedVersionCode", BuildConfig.VERSION_CODE);
        out.put("installedVersionName", BuildConfig.VERSION_NAME);
        out.put("updateAvailable", AppUpdateCoordinator.hasPendingUpdate(m));
        out.put("state", snapshot.state.name());
        out.put("message", snapshot.message);
        int progress = snapshot.totalBytes > 0 ? (int) Math.min(100L, snapshot.downloadedBytes * 100L / snapshot.totalBytes) : 0;
        out.put("progress", progress);
        out.put("downloadedBytes", snapshot.downloadedBytes);
        out.put("totalBytes", snapshot.totalBytes);
        out.put("errorCode", snapshot.error == null || snapshot.error.isEmpty() ? null : "UPDATE_FAILED");
        if (m != null) {
            out.put("latestVersionCode", m.versionCode);
            out.put("latestVersionName", m.versionName);
            out.put("mandatory", m.mandatory);
        }
        return out;
    }
}
