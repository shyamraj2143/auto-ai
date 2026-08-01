package com.autoai.app;

/** Thread-safe readiness gate for one native WebRTC media session. */
final class NativeMediaReadiness {
    private boolean iceConnected;
    private boolean peerConnected;
    private boolean remoteAudioTrack;
    private boolean remoteVideoTrack;
    private boolean firstRemoteVideoFrame;

    synchronized void reset() {
        iceConnected = false;
        peerConnected = false;
        remoteAudioTrack = false;
        remoteVideoTrack = false;
        firstRemoteVideoFrame = false;
    }

    synchronized void setIceConnected(boolean connected) { iceConnected = connected; }
    synchronized void setPeerConnected(boolean connected) { peerConnected = connected; }

    synchronized void markRemoteTrack(boolean video) {
        if (video) remoteVideoTrack = true;
        else remoteAudioTrack = true;
    }

    synchronized void markFirstRemoteVideoFrame() {
        remoteVideoTrack = true;
        firstRemoteVideoFrame = true;
    }

    synchronized boolean isTransportConnected() { return iceConnected || peerConnected; }
    synchronized boolean isMediaConnected() { return isTransportConnected() && remoteAudioTrack; }
    synchronized boolean hasRemoteVideoTrack() { return remoteVideoTrack; }
    synchronized boolean hasFirstRemoteVideoFrame() { return firstRemoteVideoFrame; }
}
