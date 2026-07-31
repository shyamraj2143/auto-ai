package com.autoai.app;

import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public class CallReliabilityHotfixContractTest {
    @Test public void nativeSignalingQueuesEventsAndRetriesTransientOutages() throws Exception {
        String controller = source("NativeCallSessionController.java");
        assertTrue(controller.contains("pendingOutboundSignals"));
        assertTrue(controller.contains("MAX_SIGNAL_RECONNECT_ATTEMPTS"));
        assertTrue(controller.contains("scheduleInitializationRetry"));
        assertTrue(controller.contains("pingInterval"));
    }

    @Test public void nativeApiRetriesTemporaryServerFailures() throws Exception {
        String api = source("NativeCallApi.java");
        assertTrue(api.contains("MAX_ATTEMPTS = 4"));
        assertTrue(api.contains("status == 503"));
        assertTrue(api.contains("Thread.sleep"));
    }

    @Test public void serviceTimeoutUsesDurableReadyStateBeforeFailing() throws Exception {
        String plugin = source("AutoAiCallsPlugin.java");
        assertTrue(plugin.contains("snapshot.isUsable()"));
        assertTrue(plugin.contains("15_000L"));
    }

    private static String source(String name) throws Exception {
        return new String(Files.readAllBytes(Paths.get("src/main/java/com/autoai/app/" + name)), StandardCharsets.UTF_8);
    }
}
