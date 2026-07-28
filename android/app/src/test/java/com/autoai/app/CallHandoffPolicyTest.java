package com.autoai.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class CallHandoffPolicyTest {
    @Test public void acceptIsNonTerminal() {
        assertTrue(CallHandoffPolicy.isAcceptAction(CallNotificationManager.ACTION_ACCEPT));
        assertFalse(CallHandoffPolicy.isTerminalAction(CallNotificationManager.ACTION_ACCEPT));
    }

    @Test public void audioOnlyIsNonTerminal() {
        assertTrue(CallHandoffPolicy.isAcceptAction(CallNotificationManager.ACTION_AUDIO_ONLY));
        assertFalse(CallHandoffPolicy.isTerminalAction(CallNotificationManager.ACTION_AUDIO_ONLY));
    }

    @Test public void rejectAndEndAreTerminal() {
        assertTrue(CallHandoffPolicy.isTerminalAction(CallNotificationManager.ACTION_REJECT));
        assertTrue(CallHandoffPolicy.isTerminalAction(CallNotificationManager.ACTION_END));
    }

    @Test public void notificationActionsUseCallScopedRequestCodes() {
        int resumeA = CallHandoffPolicy.requestCode("call-a", "resume_call");
        int resumeB = CallHandoffPolicy.requestCode("call-b", "resume_call");
        int endA = CallHandoffPolicy.requestCode("call-a", "end");
        assertNotEquals(resumeA, resumeB);
        assertNotEquals(resumeA, endA);
    }
}
