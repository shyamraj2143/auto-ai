import { AlarmClock, BellRing, Camera, MoonStar, ScanFace } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { alarmNative, speakInBrowser } from "./alarmNative";
import { formatAlarmDate } from "./alarmTime";
import { useAlarms } from "./AlarmContext";

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
  const [verificationError, setVerificationError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const openCamera = async () => {
    setVerificationError("");
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
    } catch {
      setVerificationError("Camera access is required. The alarm will continue until your live face is verified.");
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
    try {
      const result = await verifyAwake(activeAlarm.id, photo);
      if (!result.awake) {
        setVerificationError(result.reason || "Open both eyes, look directly at the camera and capture again.");
        return;
      }
      stopCamera();
      await dismissAlarm(activeAlarm.id);
    } catch (error) {
      setVerificationError(error instanceof Error ? error.message : "Groq verification is unavailable. The alarm will keep ringing.");
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
    setVerificationError("");
    setChecking(false);
    stopCamera();
    return stopCamera;
  }, [activeAlarm?.id]);

  if (!activeAlarm || alarmNative.isAndroid()) return null;
  return (
    <div className="alarm-overlay" role="dialog" aria-modal="true" aria-labelledby="active-alarm-title">
      <section className="alarm-overlay-card">
        {!cameraOpen && <span className="alarm-overlay-orbit" aria-hidden="true"><BellRing /></span>}
        <p><AlarmClock size={16} /> AutoAI Personal Assistant</p>
        <h2 id="active-alarm-title">{activeAlarm.title}</h2>
        <time>{formatAlarmDate(activeAlarm.scheduled_at)}</time>
        {cameraOpen ? (
          <div className="alarm-awake-camera">
            <video ref={videoRef} playsInline muted aria-label="Live front camera for awake verification" />
            <small><ScanFace /> Look straight at the camera with both eyes open.</small>
            {verificationError && <p role="alert">{verificationError}</p>}
            <button type="button" className="alarm-dismiss-button" disabled={checking} onClick={() => void captureAndVerify()}><Camera /> {checking ? "Groq is checking…" : "Capture awake photo"}</button>
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
