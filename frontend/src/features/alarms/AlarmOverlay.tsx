import { AlarmClock, BellRing, Bot, Camera, Check, MoonStar, ScanFace } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { alarmNative, speakInBrowser } from "./alarmNative";
import { awakeFailureSpeech, awakeSuccessSpeech } from "./alarmSpeech";
import { formatAlarmCalendarDate, formatAlarmTime24 } from "./alarmTime";
import { useAlarms } from "./AlarmContext";
import { prewarmWebAwakeVerifier, verifyAwakeOnDevice } from "./webAwakeVerifier";

function startAlarmTone() {
  if (typeof window === "undefined") return () => undefined;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return () => undefined;
  let context: AudioContext | null = null;
  let interval = 0;
  const pulse = () => {
    try {
      context ??= new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.58);
    } catch {
      // The visual alarm remains available when a browser blocks background audio.
    }
  };
  pulse();
  interval = window.setInterval(pulse, 1_300);
  return () => {
    window.clearInterval(interval);
    void context?.close();
  };
}

export function AlarmOverlay() {
  const { activeAlarm, dismissAlarm, snoozeAlarm, verifyAwake } = useAlarms();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verifierReady, setVerifierReady] = useState(false);
  const [verificationInfo, setVerificationInfo] = useState("");
  const [verificationError, setVerificationError] = useState("");
  const [verifiedMessage, setVerifiedMessage] = useState("");
  const [now, setNow] = useState(() => new Date());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const openCamera = async () => {
    setVerificationError("");
    setVerificationInfo("Preparing the private on-device face checker…");
    setVerifierReady(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setVerificationError("This browser cannot open a live camera. Use the AutoAI Android app to verify offline.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      window.setTimeout(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play();
      }, 0);
      await prewarmWebAwakeVerifier();
      setVerifierReady(true);
      setVerificationInfo("On-device AI ready · Internet is optional · Photo is not stored");
    } catch {
      stopCamera();
      setCameraOpen(false);
      setVerificationError("Camera or the on-device face checker is unavailable. The alarm will continue until your live face is verified.");
    }
  };

  const captureAndVerify = async () => {
    if (!activeAlarm || !videoRef.current || checking) return;
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) {
      setVerificationError("Camera is still starting. Keep your face visible and try again.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(960, video.videoWidth);
    canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const photo = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .82));
    if (!photo) {
      setVerificationError("Photo capture failed. Please try again.");
      return;
    }
    setChecking(true);
    setVerificationError("");
    setVerificationInfo("Checking face position and both eyes on this device…");
    try {
      const local = await verifyAwakeOnDevice(canvas);
      if (!local.awake) {
        const spoken = awakeFailureSpeech(local.code, activeAlarm.language);
        setVerificationError(local.reason);
        setVerificationInfo("Not verified · The alarm will keep ringing");
        speakInBrowser(spoken, activeAlarm.language, activeAlarm.voice_style);
        return;
      }
      let verifiedBy = "Verified offline on this device";
      if (typeof navigator === "undefined" || navigator.onLine) {
        try {
          setVerificationInfo("On-device check passed · Groq is double-checking online…");
          const online = await verifyAwake(activeAlarm.id, photo);
          if (!online.awake) {
            const failureCode = /eye|sleep|awake/i.test(online.reason) ? "eyes_closed" : "head_pose";
            setVerificationError(online.reason || "Open both eyes, look directly at the camera and capture again.");
            setVerificationInfo("Not verified · The alarm will keep ringing");
            speakInBrowser(awakeFailureSpeech(failureCode, activeAlarm.language), activeAlarm.language, activeAlarm.voice_style);
            return;
          }
          verifiedBy = "Verified on-device + Groq Vision";
        } catch {
          verifiedBy = "Verified on-device · Online check unavailable";
        }
      }
      const success = awakeSuccessSpeech(activeAlarm);
      stopCamera();
      setVerifiedMessage(success);
      setVerificationInfo(verifiedBy);
      const alarmId = activeAlarm.id;
      const language = activeAlarm.language;
      const voiceStyle = activeAlarm.voice_style;
      window.setTimeout(() => {
        void dismissAlarm(alarmId);
        window.setTimeout(() => speakInBrowser(success, language, voiceStyle), 180);
      }, 850);
    } catch {
      const spoken = awakeFailureSpeech("detector_unavailable", activeAlarm.language);
      setVerificationError("The private on-device check could not finish. Please capture again.");
      setVerificationInfo("Not verified · The alarm will keep ringing");
      speakInBrowser(spoken, activeAlarm.language, activeAlarm.voice_style);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    if (!activeAlarm || alarmNative.isAndroid()) return;
    const stopTone = startAlarmTone();
    const speakReminder = () => speakInBrowser(activeAlarm.assistant_message, activeAlarm.language, activeAlarm.voice_style);
    const speechTimer = window.setTimeout(speakReminder, 900);
    const speechInterval = window.setInterval(speakReminder, 18_000);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(activeAlarm.title, { body: activeAlarm.assistant_message, tag: `autoai-alarm-${activeAlarm.id}`, requireInteraction: true });
    }
    return () => {
      stopTone();
      window.clearTimeout(speechTimer);
      window.clearInterval(speechInterval);
      window.speechSynthesis?.cancel();
    };
  }, [activeAlarm]);

  useEffect(() => {
    setCameraOpen(false);
    setVerifierReady(false);
    setVerificationInfo("");
    setVerificationError("");
    setVerifiedMessage("");
    setChecking(false);
    stopCamera();
    return stopCamera;
  }, [activeAlarm?.id]);

  useEffect(() => {
    if (!activeAlarm) return;
    const update = () => setNow(new Date());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [activeAlarm]);

  if (!activeAlarm || alarmNative.isAndroid()) return null;
  return (
    <div className="alarm-overlay" role="dialog" aria-modal="true" aria-labelledby="active-alarm-title">
      <section className="alarm-overlay-card">
        {!cameraOpen && <span className="alarm-overlay-orbit" aria-hidden="true"><BellRing /></span>}
        <p><AlarmClock size={16} /> AutoAI Personal Assistant</p>
        <h2 id="active-alarm-title">{activeAlarm.title}</h2>
        <time>{formatAlarmTime24(now, true)} · {formatAlarmCalendarDate(activeAlarm.scheduled_at)}</time>
        {cameraOpen ? (
          <div className="alarm-awake-camera">
            {!verifiedMessage && <video ref={videoRef} playsInline muted aria-label="Live front camera for awake verification" />}
            {verifiedMessage ? (
              <div className="alarm-awake-success" role="status"><Check /><strong>Awake verified</strong><p>{verifiedMessage}</p><small><Bot /> {verificationInfo}</small></div>
            ) : (
              <>
                <small><ScanFace /> Look straight at the camera with both eyes open.</small>
                {verificationInfo && <p className="alarm-verification-info"><Bot /> {verificationInfo}</p>}
                {verificationError && <p role="alert">{verificationError}</p>}
                <button type="button" className="alarm-dismiss-button" disabled={checking || !verifierReady} onClick={() => void captureAndVerify()}><Camera /> {checking ? "Checking on this device…" : verifierReady ? "Capture & verify" : "Preparing offline AI…"}</button>
              </>
            )}
          </div>
        ) : (
          <>
            <blockquote>{activeAlarm.assistant_message}</blockquote>
            {verificationError && <p className="alarm-verification-error" role="alert">{verificationError}</p>}
            <div>
              <button type="button" className="alarm-snooze-button" onClick={() => void snoozeAlarm(activeAlarm.id, 10)}><MoonStar /> Snooze 10 min</button>
              <button type="button" className="alarm-dismiss-button" onClick={() => void openCamera()}><Camera /> Verify to stop</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
