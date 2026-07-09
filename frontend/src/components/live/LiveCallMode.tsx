import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, CameraOff, ChevronDown, ChevronUp, Mic, MicOff, PhoneOff, RotateCcw, Send, Volume2, X } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useCameraVision } from "../../hooks/useCameraVision";
import { useLiveCall } from "../../hooks/useLiveCall";

function statusLabel(status: string) {
  switch (status) {
    case "requesting_permission": return "Connecting...";
    case "listening":             return "Listening...";
    case "processing_speech":     return "Transcribing...";
    case "thinking":              return "Thinking...";
    case "speaking":              return "Speaking...";
    case "analyzing_vision":      return "Analyzing...";
    case "interrupted":           return "Listening...";
    case "error":                 return "Reconnecting";
    case "ended":                 return "Call ended";
    default:                      return "Connecting...";
  }
}

function orbColor(status: string): string {
  switch (status) {
    case "listening":
    case "interrupted": return "orb-blue";
    case "thinking":
    case "processing_speech":
    case "analyzing_vision": return "orb-amber";
    case "speaking":    return "orb-green";
    case "error":       return "orb-red";
    default:            return "orb-blue";
  }
}

export function LiveCallMode({ onClose }: { onClose: () => void }) {
  const { token } = useAuth();
  const { settings } = useAppSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [language, setLanguage] = useState("hinglish");
  const [speechRate, setSpeechRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [manualText, setManualText] = useState("");
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setSecondsElapsed((p) => p + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;

  const {
    cameraActive, cameraFacing, cameraError, setCameraError,
    startCamera, stopCamera, switchCamera, captureFrame, captureBase64Frame,
  } = useCameraVision();

  const handleBase64FrameCapture = useCallback(async (): Promise<string | null> =>
    captureBase64Frame(videoRef.current), [captureBase64Frame]);

  const captureAndAnalyzeFrame = useCallback(async (_prompt: string, _silent: boolean): Promise<string | null> => null, []);

  const {
    status, lines, interimTranscript, error,
    muted, scrollRef, toggleMute, retryCall,
    triggerResponse, endCall, addLine,
  } = useLiveCall({
    token, language, speechRate, selectedVoiceURI: voiceURI,
    cameraActive, captureAndAnalyzeFrame,
    captureBase64Frame: handleBase64FrameCapture,
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
  });

  useEffect(() => {
    const load = () => {
      if (!("speechSynthesis" in window)) return;
      const v = window.speechSynthesis.getVoices();
      setVoices(v);
      setVoiceURI((c) => c || v.find((x) => x.lang.includes("IN"))?.voiceURI || v[0]?.voiceURI || "");
    };
    load();
    if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = load;
  }, []);

  const handleToggleCamera = async () => {
    if (cameraActive) stopCamera(videoRef.current);
    else { try { await startCamera(cameraFacing, videoRef.current); } catch {} }
  };

  const handleSwitchCamera = async () => { if (cameraActive) await switchCamera(videoRef.current); };

  const handleManualAnalyze = useCallback(async () => {
    if (!cameraActive) return;
    await triggerResponse("ye kya hai? identify this for me");
  }, [cameraActive, triggerResponse]);

  const handleEndCall = async () => { await endCall(); stopCamera(videoRef.current); onClose(); };
  const handleBackClick = () => { if (window.confirm("End this Zara call?")) handleEndCall(); };

  const handleSubmitText = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    await triggerResponse(text);
  };

  return (
    <div className="lcm-shell" role="dialog" aria-modal="true">
      <style>{`
        /* ── Shell ── */
        .lcm-shell {
          position: fixed;
          inset: 0;
          z-index: 150;
          overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
          color: #f8f5ff;
          background:
            radial-gradient(circle at 50% 20%, rgba(192,132,252,0.3), transparent 32%),
            linear-gradient(135deg, #171326 0%, #241842 50%, #0f1020 100%);
        }

        /* ── Full-screen camera ── */
        .lcm-camera-bg {
          position: absolute;
          inset: 0;
          z-index: 0;
        }
        .lcm-camera-bg video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .lcm-camera-off {
          width: 100%;
          height: 100%;
          background:
            radial-gradient(ellipse at center, rgba(124,58,237,0.34) 0%, rgba(30,27,75,0.92) 56%, #0f1020 100%);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lcm-camera-off-icon {
          opacity: 0.08;
        }

        /* ── Overlay vignette ── */
        .lcm-vignette {
          position: absolute;
          inset: 0;
          z-index: 1;
          background:
            linear-gradient(to bottom,
              rgba(30,27,75,0.58) 0%,
              transparent 30%,
              transparent 55%,
              rgba(15,16,32,0.82) 100%);
          pointer-events: none;
        }

        /* ── Top bar ── */
        .lcm-topbar {
          position: absolute;
          top: 0; left: 0; right: 0;
          z-index: 20;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 14px;
        }
        .lcm-icon-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px; height: 40px;
          border-radius: 50%;
          background: rgba(255,255,255,0.14);
          backdrop-filter: blur(18px) saturate(1.18);
          border: 1px solid rgba(255,255,255,0.24);
          color: #f8f5ff;
          box-shadow: 5px 5px 14px rgba(76,29,149,0.24), -5px -5px 14px rgba(255,255,255,0.12);
          cursor: pointer;
          transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
        }
        .lcm-icon-btn:hover { background: rgba(192,132,252,0.22); transform: translateY(-2px) scale(1.04); }
        .lcm-icon-btn:active { box-shadow: inset 4px 4px 10px rgba(76,29,149,0.28), inset -4px -4px 10px rgba(255,255,255,0.12); transform: scale(0.96); }
        .lcm-icon-btn-active { background: rgba(124,58,237,0.28); border-color: rgba(192,132,252,0.6); color: #ddd6fe; }
        .lcm-icon-btn-danger { background: rgba(239,68,68,0.25); border-color: rgba(239,68,68,0.5); color: #fca5a5; }

        .lcm-call-info {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
        }
        .lcm-call-name {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #fff;
          text-shadow: 0 1px 4px rgba(76,29,149,0.5);
        }
        .lcm-call-timer {
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          color: rgba(248,245,255,0.68);
          font-family: 'SF Mono', 'Fira Code', monospace;
        }

        /* ── Signal dots ── */
        .lcm-signal { display: flex; align-items: flex-end; gap: 2px; }
        .lcm-signal span {
          width: 3px;
          background: #c084fc;
          border-radius: 2px;
          animation: lcm-signal-bounce 1.2s ease-in-out infinite;
        }
        .lcm-signal span:nth-child(1) { height: 6px; animation-delay: 0s; }
        .lcm-signal span:nth-child(2) { height: 10px; animation-delay: 0.15s; }
        .lcm-signal span:nth-child(3) { height: 14px; animation-delay: 0.3s; }
        .lcm-signal span:nth-child(4) { height: 18px; animation-delay: 0.45s; }
        @keyframes lcm-signal-bounce {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        /* ── Floating AI orb (small, corner) ── */
        .lcm-orb-pill {
          position: absolute;
          top: calc(80px + env(safe-area-inset-top, 0px));
          right: 16px;
          z-index: 25;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          cursor: default;
        }
        .lcm-orb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          position: relative;
          transition: all 0.4s ease;
        }
        .lcm-orb::before {
          content: '';
          position: absolute;
          inset: -4px;
          border-radius: 50%;
          opacity: 0.4;
          filter: blur(8px);
          transition: all 0.4s ease;
        }

        /* orb color themes */
        .orb-blue {
          background: radial-gradient(circle at 35% 35%, #f5f0ff, #a855f7 52%, #4f46e5);
          box-shadow: 0 0 24px rgba(192,132,252,0.76), 0 0 48px rgba(124,58,237,0.38);
          animation: lcm-pulse 2s ease-in-out infinite;
        }
        .orb-blue::before { background: #c084fc; }
        .orb-amber {
          background: radial-gradient(circle at 35% 35%, #fef3c7, #c084fc 48%, #7c3aed);
          box-shadow: 0 0 22px rgba(216,180,254,0.72), 0 0 44px rgba(124,58,237,0.34);
          animation: lcm-spin 2.5s linear infinite;
        }
        .orb-amber::before { background: #d8b4fe; }
        .orb-green {
          background: radial-gradient(circle at 35% 35%, #dcfce7, #22c55e 54%, #166534);
          box-shadow: 0 0 20px rgba(34,197,94,0.66), 0 0 40px rgba(124,58,237,0.24);
          animation: lcm-pulse 1s ease-in-out infinite;
        }
        .orb-green::before { background: #10b981; }
        .orb-red {
          background: radial-gradient(circle at 35% 35%, #fca5a5, #dc2626 60%, #7f1d1d);
          box-shadow: 0 0 20px rgba(239,68,68,0.7), 0 0 40px rgba(239,68,68,0.3);
        }
        .orb-red::before { background: #ef4444; }

        @keyframes lcm-pulse {
          0%, 100% { transform: scale(0.93); }
          50% { transform: scale(1.07); }
        }
        @keyframes lcm-spin {
          from { transform: rotate(0deg) scale(0.95); }
          50% { transform: rotate(180deg) scale(1.05); }
          to { transform: rotate(360deg) scale(0.95); }
        }

        .lcm-orb-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: rgba(248,245,255,0.9);
          background: rgba(255,255,255,0.14);
          backdrop-filter: blur(14px) saturate(1.18);
          border: 1px solid rgba(255,255,255,0.22);
          border-radius: 20px;
          padding: 2px 8px;
          white-space: nowrap;
          text-shadow: 0 1px 2px rgba(76,29,149,0.5);
        }

        /* ── Interim transcript bubble ── */
        .lcm-interim-bubble {
          position: absolute;
          top: calc(80px + env(safe-area-inset-top, 0px));
          left: 16px;
          right: 90px;
          z-index: 24;
          background: rgba(255,255,255,0.16);
          backdrop-filter: blur(18px) saturate(1.18);
          border: 1px solid rgba(255,255,255,0.22);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 12px;
          color: rgba(248,245,255,0.82);
          font-style: italic;
          max-lines: 2;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        /* ── Chat panel overlay (bottom) ── */
        .lcm-chat-panel {
          position: absolute;
          bottom: 0; left: 0; right: 0;
          z-index: 20;
          display: flex;
          flex-direction: column;
          transition: transform 0.35s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        .lcm-chat-panel.closed {
          transform: translateY(calc(100% - 54px));
        }

        /* chat drag handle / header */
        .lcm-chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 16px;
          background: rgba(255,255,255,0.15);
          backdrop-filter: blur(24px) saturate(1.2);
          border-top: 1px solid rgba(255,255,255,0.22);
          border-radius: 8px 8px 0 0;
          cursor: pointer;
          user-select: none;
        }
        .lcm-chat-handle {
          width: 36px; height: 4px;
          border-radius: 2px;
          background: rgba(216,180,254,0.5);
          position: absolute;
          left: 50%; transform: translateX(-50%);
          top: 8px;
        }
        .lcm-chat-header-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: rgba(248,245,255,0.72);
        }

        /* messages list */
        .lcm-messages {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px 14px;
          max-height: 42vh;
          background: rgba(30,27,75,0.58);
          backdrop-filter: blur(26px) saturate(1.18);
          overscroll-behavior: contain;
        }
        .lcm-messages::-webkit-scrollbar { width: 3px; }
        .lcm-messages::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

        .lcm-bubble {
          display: flex;
          flex-direction: column;
          max-width: 82%;
          animation: lcm-bubble-in 0.2s ease;
        }
        @keyframes lcm-bubble-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .lcm-bubble-user { align-self: flex-end; align-items: flex-end; }
        .lcm-bubble-assistant { align-self: flex-start; align-items: flex-start; }
        .lcm-bubble-system { align-self: center; align-items: center; }

        .lcm-bubble-role {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-bottom: 3px;
          opacity: 0.5;
        }
        .lcm-bubble-user .lcm-bubble-role { color: #ddd6fe; }
        .lcm-bubble-assistant .lcm-bubble-role { color: #f5d0fe; }

        .lcm-bubble-text {
          padding: 9px 13px;
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.45;
        }
        .lcm-bubble-user .lcm-bubble-text {
          background: linear-gradient(135deg, #7c3aed, #4f46e5);
          border: 1px solid rgba(255,255,255,0.18);
          color: #ffffff;
          box-shadow: 0 10px 24px rgba(124,58,237,0.32);
          border-bottom-right-radius: 4px;
        }
        .lcm-bubble-assistant .lcm-bubble-text {
          background: rgba(255,255,255,0.16);
          border: 1px solid rgba(255,255,255,0.22);
          color: #f8f5ff;
          border-bottom-left-radius: 4px;
        }
        .lcm-bubble-system .lcm-bubble-text {
          background: transparent;
          font-size: 10px;
          color: rgba(248,245,255,0.48);
          border: none;
          padding: 2px 8px;
        }

        /* ── Text input row ── */
        .lcm-input-row {
          display: flex;
          gap: 8px;
          padding: 10px 14px calc(12px + env(safe-area-inset-bottom, 0px));
          background: rgba(30,27,75,0.72);
          backdrop-filter: blur(26px) saturate(1.2);
          border-top: 1px solid rgba(255,255,255,0.18);
        }
        .lcm-text-input {
          flex: 1;
          background: rgba(255,255,255,0.16);
          border: 1px solid rgba(255,255,255,0.24);
          border-radius: 8px;
          padding: 9px 16px;
          font-size: 13px;
          color: #f8f5ff;
          outline: none;
          transition: border-color 0.2s;
          font-family: inherit;
        }
        .lcm-text-input::placeholder { color: rgba(248,245,255,0.72); }
        .lcm-text-input:focus { border-color: rgba(192,132,252,0.72); box-shadow: 0 0 0 3px rgba(192,132,252,0.16); }
        .lcm-send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px; height: 40px;
          border-radius: 50%;
          background: linear-gradient(135deg, #7c3aed, #4f46e5);
          color: #fff;
          cursor: pointer;
          border: none;
          flex-shrink: 0;
          transition: background 0.2s, transform 0.15s;
        }
        .lcm-send-btn:hover:not(:disabled) { background: linear-gradient(135deg, #8b5cf6, #4f46e5); transform: translateY(-2px) scale(1.04); }
        .lcm-send-btn:disabled { background: rgba(255,255,255,0.14); color: rgba(248,245,255,0.54); cursor: default; }

        /* ── Bottom control bar ── */
        .lcm-controls {
          position: absolute;
          right: 16px;
          z-index: 26;
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: bottom 0.35s cubic-bezier(0.25, 0.8, 0.25, 1);
        }

        /* ── Settings drawer ── */
        .lcm-settings-drawer {
          position: absolute;
          left: 0; right: 0;
          z-index: 22;
          background: rgba(30,27,75,0.78);
          backdrop-filter: blur(24px) saturate(1.2);
          border-top: 1px solid rgba(255,255,255,0.18);
          padding: 12px 16px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
          transition: transform 0.3s ease, bottom 0.35s cubic-bezier(0.25,0.8,0.25,1);
        }
        .lcm-settings-drawer.hidden { display: none; }

        .lcm-select {
          font-size: 12px;
          background: rgba(255,255,255,0.16);
          border: 1px solid rgba(255,255,255,0.24);
          border-radius: 8px;
          padding: 5px 12px;
          color: #f8f5ff;
          outline: none;
          cursor: pointer;
        }
        .lcm-speed-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: rgba(248,245,255,0.72);
          background: rgba(255,255,255,0.16);
          border: 1px solid rgba(255,255,255,0.24);
          border-radius: 8px;
          padding: 5px 12px;
        }
        .lcm-speed-label input { accent-color: #a855f7; width: 72px; }

        /* ── End call button (centered circle) ── */
        .lcm-end-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 56px; height: 56px;
          border-radius: 50%;
          background: #dc2626;
          color: #fff;
          border: none;
          cursor: pointer;
          box-shadow: 0 4px 20px rgba(220,38,38,0.5);
          transition: background 0.2s, transform 0.15s;
        }
        .lcm-end-btn:hover { background: #b91c1c; transform: scale(1.06); }

        /* ── Facing indicator badge ── */
        .lcm-facing-badge {
          position: absolute;
          bottom: 12px;
          left: 12px;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          background: rgba(255,255,255,0.16);
          backdrop-filter: blur(14px) saturate(1.18);
          border: 1px solid rgba(255,255,255,0.22);
          border-radius: 8px;
          padding: 3px 10px;
          color: rgba(248,245,255,0.72);
          z-index: 5;
        }

        /* ── Error/camera-off toast ── */
        .lcm-error-toast {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          z-index: 10;
          text-align: center;
          padding: 16px 24px;
          background: rgba(239,68,68,0.15);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(239,68,68,0.3);
          border-radius: 8px;
          color: #fca5a5;
          font-size: 13px;
          cursor: pointer;
        }

        /* Scan button */
        .lcm-scan-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 7px 16px;
          border-radius: 20px;
          background: rgba(124,58,237,0.26);
          border: 1px solid rgba(192,132,252,0.46);
          color: #f5d0fe;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          cursor: pointer;
          transition: background 0.2s;
          white-space: nowrap;
        }
        .lcm-scan-btn:hover { background: rgba(192,132,252,0.35); }
      `}</style>

      {/* ── Full-screen camera background ── */}
      <div className="lcm-camera-bg">
        {cameraActive
          ? <video ref={videoRef} playsInline muted autoPlay style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : (
            <div className="lcm-camera-off">
              <CameraOff size={96} className="lcm-camera-off-icon" />
              <video ref={videoRef} playsInline muted style={{ display: "none" }} />
            </div>
          )
        }
      </div>

      {/* Vignette overlay */}
      <div className="lcm-vignette" />

      {/* Camera facing badge */}
      {cameraActive && <span className="lcm-facing-badge">{cameraFacing === "user" ? "📷 Front" : "📷 Back"}</span>}

      {/* ── Top bar ── */}
      <div className="lcm-topbar">
        <button className="lcm-icon-btn" type="button" onClick={handleBackClick} title="End call">
          <X size={18} />
        </button>

        <div className="lcm-call-info">
          <span className="lcm-call-name">Zara</span>
          <span className="lcm-call-timer">{formatTime(secondsElapsed)}</span>
        </div>

        <div className="lcm-signal" title="Connected">
          <span /><span /><span /><span />
        </div>
      </div>

      {/* ── Floating AI orb (top-right corner, small) ── */}
      <div className="lcm-orb-pill">
        <div className={clsx("lcm-orb", orbColor(status))} />
        <span className="lcm-orb-label">{statusLabel(status)}</span>
      </div>

      {/* ── Interim speech-to-text bubble ── */}
      {interimTranscript && (
        <div className="lcm-interim-bubble">🎤 {interimTranscript}</div>
      )}

      {/* ── Error toast ── */}
      {(error || cameraError) && (
        <div className="lcm-error-toast" onClick={retryCall}>
          ⚠️ {error || cameraError}<br />
          <span style={{ fontSize: "11px", opacity: 0.7 }}>Tap to retry</span>
        </div>
      )}

      {/* ── Side controls (floated right, above chat panel) ── */}
      <div
        className="lcm-controls"
        style={{ bottom: chatOpen ? "calc(42vh + 110px)" : "80px" }}
      >
        <button
          className={clsx("lcm-icon-btn", cameraActive && "lcm-icon-btn-active")}
          type="button" onClick={handleToggleCamera} title="Toggle Camera"
        >
          {cameraActive ? <Camera size={18} /> : <CameraOff size={18} />}
        </button>

        <button
          className="lcm-icon-btn"
          type="button" onClick={handleSwitchCamera}
          disabled={!cameraActive} title="Flip Camera"
          style={{ opacity: cameraActive ? 1 : 0.4 }}
        >
          <RotateCcw size={18} />
        </button>

        {cameraActive && (
          <button className="lcm-scan-btn" type="button" onClick={handleManualAnalyze} title="Scan frame">
            Scan
          </button>
        )}

        <button
          className={clsx("lcm-icon-btn", muted && "lcm-icon-btn-danger")}
          type="button" onClick={toggleMute} title={muted ? "Unmute" : "Mute"}
        >
          {muted ? <MicOff size={18} /> : <Mic size={18} />}
        </button>

        <button className="lcm-end-btn" type="button" onClick={handleEndCall} title="End call">
          <PhoneOff size={22} />
        </button>
      </div>

      {/* ── Settings drawer (slides above chat) ── */}
      <div
        className={clsx("lcm-settings-drawer", !settingsOpen && "hidden")}
        style={{ bottom: chatOpen ? "calc(42vh + 54px)" : "54px" }}
      >
        <select className="lcm-select" value={language} onChange={(e) => setLanguage(e.target.value)}>
          <option value="hinglish">Hinglish</option>
          <option value="hindi">Hindi</option>
          <option value="english">English</option>
        </select>

        <select className="lcm-select" value={voiceURI} onChange={(e) => setVoiceURI(e.target.value)}
          style={{ maxWidth: "140px" }}>
          {voices.length
            ? voices.map((v) => <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>)
            : <option value="">System Voice</option>
          }
        </select>

        <label className="lcm-speed-label">
          <Volume2 size={12} />
          <input type="range" min="0.7" max="1.4" step="0.1" value={speechRate}
            onChange={(e) => setSpeechRate(Number(e.target.value))} />
          <span>{speechRate}×</span>
        </label>
      </div>

      {/* ── Chat panel (overlay, bottom slide-up) ── */}
      <div className={clsx("lcm-chat-panel", !chatOpen && "closed")}>
        {/* Drag handle / header */}
        <div className="lcm-chat-header" onClick={() => setChatOpen((p) => !p)}>
          <div className="lcm-chat-handle" />
          <span className="lcm-chat-header-title">Conversation</span>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              className="lcm-icon-btn"
              style={{ width: 30, height: 30, background: "transparent", border: "none" }}
              type="button"
              onClick={(e) => { e.stopPropagation(); setSettingsOpen((p) => !p); }}
              title="Voice settings"
            >
              <Volume2 size={14} />
            </button>
            {chatOpen ? <ChevronDown size={14} style={{ opacity: 0.5 }} /> : <ChevronUp size={14} style={{ opacity: 0.5 }} />}
          </div>
        </div>

        {/* Messages */}
        <div className="lcm-messages" ref={scrollRef}>
          {lines.length === 0 ? (
            <span style={{ alignSelf: "center", color: "rgba(255,255,255,0.25)", fontSize: "12px", fontStyle: "italic", marginTop: "auto" }}>
              Start speaking…
            </span>
          ) : (
            lines.map((line) => (
              <div key={line.id} className={clsx("lcm-bubble", `lcm-bubble-${line.role}`)}>
                <span className="lcm-bubble-role">
                  {line.role === "user" ? "You" : line.role === "assistant" ? "Zara" : "System"}
                </span>
                <div className="lcm-bubble-text">{line.text}</div>
              </div>
            ))
          )}
        </div>

        {/* Text input */}
        <form className="lcm-input-row" onSubmit={handleSubmitText}>
          <input
            className="lcm-text-input"
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Type a message…"
          />
          <button className="lcm-send-btn" type="submit" disabled={!manualText.trim()}>
            <Send size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}
