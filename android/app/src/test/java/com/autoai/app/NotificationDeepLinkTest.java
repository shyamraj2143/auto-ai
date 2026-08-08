package com.autoai.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class NotificationDeepLinkTest {
    @Test public void legacyTypesHaveExplicitDestinations() {
        assertEquals("MESSAGE_THREAD", NotificationDeepLink.destinationForLegacyType(null, "chat_message"));
        assertEquals("MISSED_CALL", NotificationDeepLink.destinationForLegacyType(null, "call_missed"));
        assertEquals("FOLLOW_REQUEST", NotificationDeepLink.destinationForLegacyType(null, "follow_request"));
        assertEquals("FOLLOW_ACCEPTED", NotificationDeepLink.destinationForLegacyType(null, "follow_accept"));
        assertEquals("APP_UPDATE", NotificationDeepLink.destinationForLegacyType(null, "apk_update"));
        assertEquals("RELATIONSHIP_FOLLOWUP", NotificationDeepLink.destinationForLegacyType(null, "relationship_followup"));
        assertEquals("SEVA_CASE", NotificationDeepLink.destinationForLegacyType(null, "seva_case_update"));
        assertNull(NotificationDeepLink.destinationForLegacyType(null, "unknown"));
    }

    @Test public void pendingIntentIdentityIncludesActionAndEntity() {
        assertNotEquals(NotificationDeepLink.requestCode("CALL_HISTORY", "a", "open"), NotificationDeepLink.requestCode("CALL_HISTORY", "b", "open"));
        assertNotEquals(NotificationDeepLink.requestCode("CALL_HISTORY", "a", "open"), NotificationDeepLink.requestCode("CALL_HISTORY", "a", "reply"));
    }
}
