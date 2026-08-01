package com.autoai.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeMediaReadinessTest {
    @Test public void negotiatedAudioTrackAloneIsNotConnectedMedia() {
        NativeMediaReadiness readiness = new NativeMediaReadiness();
        readiness.markRemoteTrack(false);

        assertFalse(readiness.isMediaConnected());
        readiness.setIceConnected(true);
        assertTrue(readiness.isMediaConnected());
    }

    @Test public void transportWithoutRemoteAudioIsNotConnectedMedia() {
        NativeMediaReadiness readiness = new NativeMediaReadiness();
        readiness.setPeerConnected(true);

        assertFalse(readiness.isMediaConnected());
        readiness.markRemoteTrack(false);
        assertTrue(readiness.isMediaConnected());
    }

    @Test public void videoReadinessIsIndependentFromAudioOrdering() {
        NativeMediaReadiness readiness = new NativeMediaReadiness();
        readiness.markRemoteTrack(false);
        readiness.markRemoteTrack(true);

        assertTrue(readiness.hasRemoteVideoTrack());
        assertFalse(readiness.hasFirstRemoteVideoFrame());
        readiness.markFirstRemoteVideoFrame();
        assertTrue(readiness.hasFirstRemoteVideoFrame());
    }

    @Test public void transportLossRemovesConnectedReadinessUntilRecovery() {
        NativeMediaReadiness readiness = new NativeMediaReadiness();
        readiness.markRemoteTrack(false);
        readiness.setIceConnected(true);
        assertTrue(readiness.isMediaConnected());

        readiness.setIceConnected(false);
        assertFalse(readiness.isMediaConnected());
        readiness.setPeerConnected(true);
        assertTrue(readiness.isMediaConnected());
    }
}
