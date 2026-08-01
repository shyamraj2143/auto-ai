package com.autoai.app;

import android.content.Context;
import android.util.Log;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.Camera1Enumerator;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraEnumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.RendererCommon;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/** One native PeerConnection and local media graph for one Android call. */
final class NativeWebRtcEngine {
    interface Listener {
        void onLocalDescription(SessionDescription description);
        void onLocalIceCandidate(IceCandidate candidate);
        void onIceState(PeerConnection.IceConnectionState state);
        void onPeerConnectionState(PeerConnection.PeerConnectionState state);
        void onRemoteTrack(boolean video);
        void onFirstRemoteVideoFrame();
        default void onRemoteDescriptionApplied(SessionDescription.Type type) {}
        void onFailure(String errorCode, Throwable error);
    }

    private static final String TAG = "AutoAiNativeWebRtc";
    private static final Object FACTORY_LOCK = new Object();
    private static PeerConnectionFactory factory;
    private static EglBase eglBase;
    private static JavaAudioDeviceModule audioDeviceModule;

    private final Context context;
    private final Listener listener;
    private final List<IceCandidate> queuedRemoteCandidates = new ArrayList<>();
    private final AtomicBoolean negotiationRunning = new AtomicBoolean(false);
    private final AtomicBoolean firstRemoteVideoFrameReported = new AtomicBoolean(false);
    private PeerConnection peerConnection;
    private AudioSource audioSource;
    private AudioTrack localAudioTrack;
    private VideoSource videoSource;
    private VideoTrack localVideoTrack;
    private VideoTrack remoteVideoTrack;
    private VideoCapturer videoCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;
    private SurfaceViewRenderer localRenderer;
    private SurfaceViewRenderer remoteRenderer;
    private boolean remoteDescriptionSet;
    private boolean videoEnabled;

    NativeWebRtcEngine(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
    }

    void start(boolean video, List<PeerConnection.IceServer> iceServers) {
        ensureFactory();
        videoEnabled = video;
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        config.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        config.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;
        config.keyType = PeerConnection.KeyType.ECDSA;
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        config.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED;
        config.iceCandidatePoolSize = 2;
        peerConnection = factory.createPeerConnection(config, observer);
        if (peerConnection == null) throw new IllegalStateException("PeerConnection creation failed.");

        audioSource = factory.createAudioSource(new MediaConstraints());
        localAudioTrack = factory.createAudioTrack("autoai-audio", audioSource);
        localAudioTrack.setEnabled(true);
        peerConnection.addTrack(localAudioTrack, Collections.singletonList("autoai"));
        if (video) startCamera();
    }

    void createOffer(boolean iceRestart) {
        if (peerConnection == null || !negotiationRunning.compareAndSet(false, true)) return;
        MediaConstraints constraints = offerAnswerConstraints();
        if (iceRestart) constraints.mandatory.add(new MediaConstraints.KeyValuePair("IceRestart", "true"));
        peerConnection.createOffer(localDescriptionObserver, constraints);
    }

    void applyOffer(String sdp) {
        setRemoteDescription(new SessionDescription(SessionDescription.Type.OFFER, sdp), () -> {
            if (!negotiationRunning.compareAndSet(false, true)) return;
            peerConnection.createAnswer(localDescriptionObserver, offerAnswerConstraints());
        });
    }

    void applyAnswer(String sdp) {
        setRemoteDescription(new SessionDescription(SessionDescription.Type.ANSWER, sdp), null);
    }

    synchronized void addRemoteCandidate(String mid, int lineIndex, String candidate) {
        IceCandidate ice = new IceCandidate(mid, lineIndex, candidate);
        if (!remoteDescriptionSet || peerConnection == null) {
            queuedRemoteCandidates.add(ice);
        } else {
            peerConnection.addIceCandidate(ice);
        }
    }

    synchronized void restartIce() {
        if (peerConnection == null) return;
        remoteDescriptionSet = false;
        peerConnection.restartIce();
        createOffer(true);
    }

    void setMuted(boolean muted) { if (localAudioTrack != null) localAudioTrack.setEnabled(!muted); }
    void setCameraEnabled(boolean enabled) { if (localVideoTrack != null) localVideoTrack.setEnabled(enabled); }
    void switchCamera() {
        if (videoCapturer instanceof CameraVideoCapturer) {
            ((CameraVideoCapturer) videoCapturer).switchCamera(null);
        }
    }

    synchronized void attachRenderers(SurfaceViewRenderer local, SurfaceViewRenderer remote) {
        if (localRenderer == local && remoteRenderer == remote) return;
        if (localRenderer != null || remoteRenderer != null) detachRenderers();
        localRenderer = local;
        remoteRenderer = remote;
        if (eglBase == null) return;
        if (localRenderer != null) {
            localRenderer.init(eglBase.getEglBaseContext(), null);
            localRenderer.setMirror(true);
            localRenderer.setEnableHardwareScaler(true);
            localRenderer.setZOrderMediaOverlay(true);
            if (localVideoTrack != null) localVideoTrack.addSink(localRenderer);
        }
        if (remoteRenderer != null) {
            remoteRenderer.init(eglBase.getEglBaseContext(), remoteRendererEvents);
            remoteRenderer.setMirror(false);
            remoteRenderer.setEnableHardwareScaler(true);
            if (remoteVideoTrack != null) remoteVideoTrack.addSink(remoteRenderer);
        }
    }

    synchronized void detachRenderers() {
        if (localVideoTrack != null && localRenderer != null) localVideoTrack.removeSink(localRenderer);
        if (remoteVideoTrack != null && remoteRenderer != null) remoteVideoTrack.removeSink(remoteRenderer);
        if (localRenderer != null) localRenderer.release();
        if (remoteRenderer != null) remoteRenderer.release();
        localRenderer = null;
        remoteRenderer = null;
    }

    synchronized void close() {
        detachRenderers();
        if (videoCapturer != null) {
            try { videoCapturer.stopCapture(); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            videoCapturer.dispose();
        }
        if (surfaceTextureHelper != null) surfaceTextureHelper.dispose();
        if (localVideoTrack != null) localVideoTrack.dispose();
        if (videoSource != null) videoSource.dispose();
        if (localAudioTrack != null) localAudioTrack.dispose();
        if (audioSource != null) audioSource.dispose();
        if (peerConnection != null) { peerConnection.close(); peerConnection.dispose(); }
        peerConnection = null;
        queuedRemoteCandidates.clear();
        remoteDescriptionSet = false;
    }

    private void ensureFactory() {
        synchronized (FACTORY_LOCK) {
            if (factory != null) return;
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context)
                .setEnableInternalTracer(false).createInitializationOptions());
            eglBase = EglBase.create();
            audioDeviceModule = JavaAudioDeviceModule.builder(context).createAudioDeviceModule();
            factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(audioDeviceModule)
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
                .createPeerConnectionFactory();
        }
    }

    private void startCamera() {
        CameraEnumerator enumerator = Camera2Enumerator.isSupported(context) ? new Camera2Enumerator(context) : new Camera1Enumerator(false);
        for (String name : enumerator.getDeviceNames()) {
            if (enumerator.isFrontFacing(name)) { videoCapturer = enumerator.createCapturer(name, null); break; }
        }
        if (videoCapturer == null) {
            for (String name : enumerator.getDeviceNames()) {
                videoCapturer = enumerator.createCapturer(name, null);
                if (videoCapturer != null) break;
            }
        }
        if (videoCapturer == null) throw new IllegalStateException("Camera capturer unavailable.");
        videoSource = factory.createVideoSource(false);
        surfaceTextureHelper = SurfaceTextureHelper.create("AutoAiCamera", eglBase.getEglBaseContext());
        videoCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
        videoCapturer.startCapture(1280, 720, 30);
        localVideoTrack = factory.createVideoTrack("autoai-video", videoSource);
        peerConnection.addTrack(localVideoTrack, Collections.singletonList("autoai"));
    }

    private void setRemoteDescription(SessionDescription description, Runnable complete) {
        if (peerConnection == null) return;
        synchronized (this) { remoteDescriptionSet = false; }
        peerConnection.setRemoteDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                List<IceCandidate> candidates;
                synchronized (NativeWebRtcEngine.this) {
                    remoteDescriptionSet = true;
                    candidates = new ArrayList<>(queuedRemoteCandidates);
                    queuedRemoteCandidates.clear();
                }
                listener.onRemoteDescriptionApplied(description.type);
                for (IceCandidate candidate : candidates) peerConnection.addIceCandidate(candidate);
                if (complete != null) complete.run();
            }
            @Override public void onSetFailure(String error) { listener.onFailure("REMOTE_OFFER_INVALID", new IllegalStateException(error)); }
        }, description);
    }

    private final SdpObserver localDescriptionObserver = new SimpleSdpObserver() {
        @Override public void onCreateSuccess(SessionDescription description) {
            peerConnection.setLocalDescription(new SimpleSdpObserver() {
                @Override public void onSetSuccess() {
                    negotiationRunning.set(false);
                    listener.onLocalDescription(description);
                }
                @Override public void onSetFailure(String error) {
                    negotiationRunning.set(false);
                    listener.onFailure("ANSWER_CREATE_FAILED", new IllegalStateException(error));
                }
            }, description);
        }
        @Override public void onCreateFailure(String error) {
            negotiationRunning.set(false);
            listener.onFailure("ANSWER_CREATE_FAILED", new IllegalStateException(error));
        }
    };

    private final PeerConnection.Observer observer = new PeerConnection.Observer() {
        @Override public void onSignalingChange(PeerConnection.SignalingState state) { Log.d(TAG, "signaling=" + state); }
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { listener.onIceState(state); }
        @Override public void onConnectionChange(PeerConnection.PeerConnectionState state) { listener.onPeerConnectionState(state); }
        @Override public void onIceConnectionReceivingChange(boolean receiving) { Log.d(TAG, "iceReceiving=" + receiving); }
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {}
        @Override public void onIceCandidate(IceCandidate candidate) { listener.onLocalIceCandidate(candidate); }
        @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
        @Override public void onAddStream(MediaStream stream) {}
        @Override public void onRemoveStream(MediaStream stream) {}
        @Override public void onDataChannel(DataChannel channel) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] mediaStreams) {
            if (receiver.track() instanceof VideoTrack) {
                synchronized (NativeWebRtcEngine.this) {
                    remoteVideoTrack = (VideoTrack) receiver.track();
                    remoteVideoTrack.setEnabled(true);
                    if (remoteRenderer != null) remoteVideoTrack.addSink(remoteRenderer);
                }
                listener.onRemoteTrack(true);
            } else if (receiver.track() instanceof AudioTrack) {
                receiver.track().setEnabled(true);
                listener.onRemoteTrack(false);
            }
        }
    };

    private final RendererCommon.RendererEvents remoteRendererEvents = new RendererCommon.RendererEvents() {
        @Override public void onFirstFrameRendered() {
            if (firstRemoteVideoFrameReported.compareAndSet(false, true)) listener.onFirstRemoteVideoFrame();
        }

        @Override public void onFrameResolutionChanged(int videoWidth, int videoHeight, int rotation) {
            Log.d(TAG, "remoteVideo=" + videoWidth + "x" + videoHeight + " rotation=" + rotation);
        }
    };

    private MediaConstraints offerAnswerConstraints() {
        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", Boolean.toString(videoEnabled)));
        return constraints;
    }

    private abstract static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String error) {}
        @Override public void onSetFailure(String error) {}
    }
}
