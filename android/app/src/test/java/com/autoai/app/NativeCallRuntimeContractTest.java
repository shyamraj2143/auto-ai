package com.autoai.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Arrays;

public class NativeCallRuntimeContractTest {
    @Test public void durableStateMachineContainsEveryRequiredStateInOrder() {
        assertArrayEquals(new String[] {
            "INCOMING_PRESENTED", "ACCEPT_REQUESTED", "ACCEPT_COMMITTED", "SERVICE_STARTING",
            "SERVICE_READY", "ACTIVE_UI_STARTING", "ACTIVE_UI_READY", "SIGNALING_CONNECTING",
            "SIGNALING_CONNECTED", "MEDIA_CONNECTING", "MEDIA_CONNECTED", "RECONNECTING", "TERMINAL"
        }, Arrays.stream(ActiveCallStore.State.values()).map(Enum::name).toArray(String[]::new));
    }

    @Test public void acceptedCallComponentsNeverLaunchMainActivity() throws Exception {
        for (String file : new String[] { "IncomingCallActivity.java", "CallActionReceiver.java", "CallForegroundService.java", "AutoAiTelecomBridge.java" }) {
            String source = source("java/com/autoai/app/" + file);
            assertFalse(file, source.contains("new Intent(context, MainActivity.class)") || source.contains("new Intent(this, MainActivity.class)"));
        }
        assertTrue(source("java/com/autoai/app/CallForegroundService.java").contains("new Intent(this, ActiveCallActivity.class)"));
    }

    @Test public void lockScreenActivityDoesNotDismissKeyguardOrContainWebView() throws Exception {
        String source = source("java/com/autoai/app/ActiveCallActivity.java");
        assertTrue(source.contains("setShowWhenLocked(true)"));
        assertTrue(source.contains("setTurnScreenOn(true)"));
        assertFalse(source.contains("requestDismissKeyguard"));
        assertFalse(source.contains("WebView"));
    }

    @Test public void nativeRuntimeOwnsSignalingPeerConnectionAndRemoteMediaGate() throws Exception {
        String controller = source("java/com/autoai/app/NativeCallSessionController.java");
        String engine = source("java/com/autoai/app/NativeWebRtcEngine.java");
        assertTrue(controller.contains("api.websocketUrl()"));
        assertTrue(controller.contains("call.connected"));
        assertTrue(controller.contains("REMOTE_MEDIA_RECEIVED"));
        assertTrue(controller.contains("mediaReadiness.isMediaConnected()"));
        assertTrue(controller.contains("MAX_ICE_RESTART_ATTEMPTS"));
        assertTrue(controller.contains("INITIAL_MEDIA_TIMEOUT_MS"));
        assertFalse(controller.contains("if (remoteMediaReceived) return"));
        assertTrue(engine.contains("PeerConnection peerConnection"));
        assertTrue(engine.contains("queuedRemoteCandidates"));
        assertTrue(engine.contains("restartIce()"));
        assertTrue(engine.contains("onConnectionChange"));
        assertTrue(engine.contains("onFirstFrameRendered"));
        assertTrue(engine.contains("listener.onRemoteTrack(true)"));
        assertTrue(engine.contains("listener.onRemoteTrack(false)"));
    }

    @Test public void modernAudioAndVideoPresentationAreExplicit() throws Exception {
        String activity = source("java/com/autoai/app/ActiveCallActivity.java");
        String service = source("java/com/autoai/app/CallForegroundService.java");
        String router = source("java/com/autoai/app/NativeAudioRouter.java");
        assertTrue(activity.contains("remoteVideo.setVisibility(View.VISIBLE)"));
        assertTrue(activity.contains("NativeAudioRouter.routeForCall"));
        assertTrue(service.contains("NativeAudioRouter.routeForCall"));
        assertTrue(router.contains("setCommunicationDevice"));
    }

    @Test public void manifestProtectsDedicatedActiveCallActivity() throws Exception {
        String manifest = read("src/main/AndroidManifest.xml");
        int start = manifest.indexOf("android:name=\".ActiveCallActivity\"");
        int end = manifest.indexOf("/>", start);
        String declaration = manifest.substring(start, end);
        assertTrue(declaration.contains("android:exported=\"false\""));
        assertTrue(declaration.contains("android:showWhenLocked=\"true\""));
        assertTrue(declaration.contains("android:turnScreenOn=\"true\""));
        assertTrue(declaration.contains("android:launchMode=\"singleTask\""));
    }

    private static String source(String relative) throws Exception {
        return read("src/main/" + relative);
    }

    private static String read(String relative) throws Exception {
        return new String(Files.readAllBytes(Paths.get(relative)), StandardCharsets.UTF_8);
    }
}
