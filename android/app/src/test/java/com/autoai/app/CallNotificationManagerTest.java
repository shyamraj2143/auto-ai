package com.autoai.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class CallNotificationManagerTest {
    @Test
    public void incomingChannelUsesVersionThree() {
        assertEquals("auto_ai_incoming_calls_v3", CallNotificationManager.CHANNEL_INCOMING);
    }

    @Test
    public void pendingIntentIdentityIncludesCallActionAndRevision() {
        int accept = CallNotificationManager.requestCode("call-1", "accept", 4L);
        assertNotEquals(accept, CallNotificationManager.requestCode("call-1", "decline", 4L));
        assertNotEquals(accept, CallNotificationManager.requestCode("call-1", "accept", 5L));
        assertNotEquals(accept, CallNotificationManager.requestCode("call-2", "accept", 4L));
    }
}
