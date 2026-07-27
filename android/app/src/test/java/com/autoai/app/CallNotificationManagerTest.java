package com.autoai.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class CallNotificationManagerTest {
    @Test
    public void incomingChannelUsesVersionFour() {
        assertEquals("auto_ai_incoming_calls_v4", CallNotificationManager.CHANNEL_INCOMING);
        assertEquals("auto_ai_incoming_calls_v3", CallNotificationManager.CHANNEL_INCOMING_V3);
    }

    @Test
    public void pendingIntentIdentityIncludesCallActionAndRevision() {
        int accept = CallNotificationManager.requestCode("call-1", "accept", 4L);
        assertNotEquals(accept, CallNotificationManager.requestCode("call-1", "decline", 4L));
        assertNotEquals(accept, CallNotificationManager.requestCode("call-1", "accept", 5L));
        assertNotEquals(accept, CallNotificationManager.requestCode("call-2", "accept", 4L));
    }

    @Test
    public void primaryAndFallbackShareNotificationTag() {
        assertEquals("autoai_call_call-1", CallNotificationManager.notificationTag("call-1"));
    }
}
