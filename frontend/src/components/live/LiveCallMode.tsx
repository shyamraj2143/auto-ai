import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Camera, CameraOff, Mic, MicOff, PhoneOff, RotateCcw, Send, Volume2, X } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useCameraVision } from "../../hooks/useCameraVision";
import { useLiveCall } from "../../hooks/useLiveCall";

function statusLabel(status: string) {
  switch (status) {
    case "requesting_permission":
      return "Connecting...";
    case "listening":
      return "Listening...";
    case "processing_speech":
      return "Suno, likh rahi hoon...";
    case "thinking":
      return "Soch rahi hoon...";
    case "speaking":
      return "Speaking...";
    case "analyzing_vision":
      return "Dekh rahi hoon...";
    case "interrupted":
      return "Listening...";
    case "error":
      return "Connection interrupted";
    case "ended":
      return "Call ended";
    default:
      return "Connecting...";
  }
}

export function LiveCallMode({ onClose }: { onClose: () => void }) {
  const { token } = useAuth();
  const { settings } = useAppSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // States
  const [language, setLanguage] = useState("hinglish");
  const [speechRate, setSpeechRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [manualText, setManualText] = useState("");
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [isTranscriptExpanded, setIsTranscriptExpanded] = useState(false);

  // Track elapsed call time
  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  // Initialize camera controller hook
  const {
    cameraActive,
    cameraFacing,
    cameraError,
    setCameraError,
    startCamera,
    stopCamera,
    switchCamera,
    captureFrame,
    captureBase64Frame,
  } = useCameraVision();

  // On-demand base64 frame capture
  const handleBase64FrameCapture = useCallback(async (): Promise<string | null> => {
    return captureBase64Frame(videoRef.current);
  }, [captureBase64Frame]);

  // Fallback direct analysis frame upload
  const captureAndAnalyzeFrame = useCallback(
    async (prompt: string, silent: boolean): Promise<string | null> => {
      // Stub wrapper if needed, base64 is primary for live messages
      return null;
    },
    []
  );

  // Initialize unified Live Call state controller
  const {
    status,
    lines,
    interimTranscript,
    error,
    muted,
    scrollRef,
    toggleMute,
    retryCall,
    triggerResponse,
    endCall,
    addLine,
  } = useLiveCall({
    token,
    language,
    speechRate,
    selectedVoiceURI: voiceURI,
    cameraActive,
    captureAndAnalyzeFrame,
    captureBase64Frame: handleBase64FrameCapture,
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
  });

  // Load available speech synthesis voices
  useEffect(() => {
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) return;
      const nextVoices = window.speechSynthesis.getVoices();
      setVoices(nextVoices);
      setVoiceURI((current) => current || nextVoices.find((v) => v.lang.includes("IN"))?.voiceURI || nextVoices[0]?.voiceURI || "");
    };
    loadVoices();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Toggle video stream
  const handleToggleCamera = async () => {
    if (cameraActive) {
      stopCamera(videoRef.current);
    } else {
      try {
        await startCamera(cameraFacing, videoRef.current);
      } catch (e) {
        // Error is set in cameraError
      }
    }
  };

  // Switch facing cameras
  const handleSwitchCamera = async () => {
    if (!cameraActive) return;
    await switchCamera(videoRef.current);
  };

  // Handle manual frame analysis trigger — delegates to triggerResponse with a visual keyword
  const handleManualAnalyze = useCallback(async () => {
    if (!cameraActive) return;
    // The triggerResponse will auto-detect visual keywords and capture the base64 frame
    await triggerResponse("ye kya hai? identify this for me");
  }, [cameraActive, triggerResponse]);

  const handleEndCall = async () => {
    await endCall();
    stopCamera(videoRef.current);
    onClose();
  };

  // Exit with user confirmation
  const handleBackClick = () => {
    const confirmExit = window.confirm("Are you sure you want to end the Zara call?");
    if (confirmExit) {
      handleEndCall();
    }
  };

  const handleSubmitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    await triggerResponse(text);
  };

  return (
    <div className={clsx("vibe-call-shell", cameraActive && "vibe-call-camera-on")} role="dialog" aria-modal="true">
      {/* Vibe Call Custom styling overrides */}
      <style>{`
        .vibe-call-shell {
          position: fixed;
          inset: 0;
          z-index: 150;
          display: grid;
          grid-template-rows: auto 1fr auto;
          overflow: hidden;
          background: radial-gradient(circle at center, #11111f 0%, #0a0a0f 100%);
          color: #f8fafc;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .vibe-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(10, 10, 15, 0.7);
          backdrop-filter: blur(12px);
          z-index: 10;
        }
        .vibe-main {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 16px;
          overflow: hidden;
        }
        /* Orb area styling */
        .vibe-orb-container {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
        }
        .vibe-orb-glow {
          position: relative;
          width: 160px;
          height: 160px;
          border-radius: 999px;
          background: radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 70%);
          transition: all 0.5s ease;
        }
        
        /* Shimmering orb color states */
        .vibe-orb-state-listening {
          background: radial-gradient(circle, #3b82f6 0%, rgba(59, 130, 246, 0.1) 70%);
          box-shadow: 0 0 50px rgba(59, 130, 246, 0.6), inset 0 0 30px rgba(59, 130, 246, 0.4);
          animation: vibe-pulse-anim 2s infinite ease-in-out;
        }
        .vibe-orb-state-thinking {
          background: radial-gradient(circle, #f59e0b 0%, rgba(245, 158, 11, 0.1) 70%);
          box-shadow: 0 0 50px rgba(245, 158, 11, 0.6), inset 0 0 30px rgba(245, 158, 11, 0.4);
          animation: vibe-spin-anim 3s infinite linear;
        }
        .vibe-orb-state-speaking {
          background: radial-gradient(circle, #10b981 0%, rgba(16, 185, 129, 0.1) 70%);
          box-shadow: 0 0 60px rgba(16, 185, 129, 0.7), inset 0 0 30px rgba(16, 185, 129, 0.5);
          animation: vibe-pulse-anim 1.2s infinite ease-in-out;
        }
        .vibe-orb-state-error {
          background: radial-gradient(circle, #ef4444 0%, rgba(239, 68, 68, 0.1) 70%);
          box-shadow: 0 0 50px rgba(239, 68, 68, 0.6), inset 0 0 30px rgba(239, 68, 68, 0.4);
        }

        @keyframes vibe-pulse-anim {
          0%, 100% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.08); opacity: 1; }
        }
        @keyframes vibe-spin-anim {
          0% { transform: rotate(0deg) scale(0.98); }
          50% { transform: rotate(180deg) scale(1.05); }
          100% { transform: rotate(360deg) scale(0.98); }
        }

        /* Camera panel layout and PIP settings */
        .vibe-camera-frame {
          width: 100%;
          max-width: 480px;
          height: 280px;
          border-radius: 12px;
          overflow: hidden;
          background: #000;
          border: 1px solid rgba(255, 255, 255, 0.08);
          margin-top: 16px;
          position: relative;
          transition: all 0.4s ease;
        }
        .vibe-call-camera-on .vibe-camera-frame {
          position: absolute;
          top: 16px;
          right: 16px;
          width: 110px;
          height: 150px;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
          z-index: 20;
          border: 1px solid rgba(255, 255, 255, 0.15);
        }
        .vibe-call-camera-on .vibe-orb-container {
          transform: translateY(-20px);
        }
        .vibe-camera-frame video {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        /* Transcript Overlay Panel */
        .vibe-transcript-panel {
          position: absolute;
          bottom: 12px;
          left: 12px;
          right: 12px;
          height: 30%;
          background: rgba(10, 10, 15, 0.75);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 12px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow: hidden;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          z-index: 30;
        }
        .vibe-transcript-panel-expanded {
          height: 75%;
          background: rgba(8, 8, 12, 0.95);
        }
        .vibe-transcript-scroll {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-right: 4px;
        }
        .vibe-transcript-line {
          font-size: 13px;
          line-height: 1.4;
          padding: 4px 8px;
          border-radius: 6px;
          max-width: 90%;
        }
        .vibe-transcript-user {
          align-self: flex-end;
          background: rgba(59, 130, 246, 0.15);
          border: 1px solid rgba(59, 130, 246, 0.25);
          color: #93c5fd;
        }
        .vibe-transcript-assistant {
          align-self: flex-start;
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #f1f5f9;
        }
        .vibe-transcript-system {
          align-self: center;
          font-size: 11px;
          color: #94a3b8;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
        }
        
        .vibe-controls-bar {
          display: flex;
          align-items: center;
          justify-content: space-around;
          padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(8, 8, 12, 0.9);
          z-index: 10;
        }
      `}</style>

      {/* Top Header Bar */}
      <div className="vibe-topbar">
        <button className="p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition-colors" type="button" onClick={handleBackClick}>
          <X size={20} />
        </button>

        <div className="flex flex-col items-center">
          <span className="text-xs font-semibold uppercase tracking-wider text-cyan-400">Zara Calling</span>
          <span className="text-[11px] text-slate-400 font-mono mt-0.5">{formatTime(secondsElapsed)}</span>
        </div>

        {/* Fake network indicator */}
        <div className="flex items-end gap-0.5 p-2" title="Network status">
          <span className="w-0.5 h-1.5 bg-emerald-500 rounded-full"></span>
          <span className="w-0.5 h-2.5 bg-emerald-500 rounded-full"></span>
          <span className="w-0.5 h-3.5 bg-emerald-500 rounded-full"></span>
          <span className="w-0.5 h-4.5 bg-emerald-500 rounded-full"></span>
        </div>
      </div>

      {/* Main Vision/Visual Orb View */}
      <div className="vibe-main">
        {/* Shimmering Center Orb */}
        <div className="vibe-orb-container">
          <div
            className={clsx(
              "vibe-orb-glow",
              status === "listening" && "vibe-orb-state-listening",
              status === "speaking" && "vibe-orb-state-speaking",
              (status === "thinking" || status === "processing_speech" || status === "analyzing_vision") && "vibe-orb-state-thinking",
              status === "error" && "vibe-orb-state-error",
              status === "idle" && "vibe-orb-state-listening"
            )}
          />
          <span className="text-sm font-medium tracking-wide text-slate-300">{statusLabel(status)}</span>
          {(error || cameraError) && (
            <span className="text-xs text-red-400 text-center px-4 max-w-[280px] bg-red-950/20 border border-red-500/20 py-1.5 rounded-lg" onClick={retryCall}>
              {error || cameraError}
            </span>
          )}
          {interimTranscript && <span className="text-xs text-slate-400 max-w-[280px] text-center">{interimTranscript}</span>}
        </div>

        {/* Video feed block */}
        <div className={clsx("vibe-camera-frame", !cameraActive && "hidden")}>
          <video ref={videoRef} playsInline muted />
          {cameraActive && <span className="absolute bottom-2 left-2 text-[9px] bg-black/60 px-2 py-0.5 rounded-full border border-white/5">{cameraFacing === "user" ? "Front" : "Back"}</span>}
        </div>

        {/* Compact Transcript log overlay */}
        <div
          className={clsx("vibe-transcript-panel", isTranscriptExpanded && "vibe-transcript-panel-expanded")}
          onClick={() => setIsTranscriptExpanded((prev) => !prev)}
        >
          <div className="flex justify-between items-center text-[10px] text-slate-400 font-semibold tracking-wider uppercase border-b border-white/5 pb-1">
            <span>Live Transcript Log</span>
            <span>{isTranscriptExpanded ? "Tap to close" : "Tap to expand"}</span>
          </div>

          <div className="vibe-transcript-scroll" ref={scrollRef}>
            {lines.length === 0 ? (
              <span className="text-slate-500 text-xs italic self-center my-auto">Start speaking to transcribe...</span>
            ) : (
              lines.map((line) => (
                <div key={line.id} className={clsx("vibe-transcript-line", `vibe-transcript-${line.role}`)}>
                  <span className="text-[9px] block opacity-60 font-bold uppercase tracking-wider mb-0.5">{line.role === "user" ? "You" : line.role === "assistant" ? "Zara" : "System"}</span>
                  {line.text}
                </div>
              ))
            )}
          </div>

          {isTranscriptExpanded && (
            <form className="flex gap-2 mt-2" onSubmit={handleSubmitText} onClick={(e) => e.stopPropagation()}>
              <input
                className="flex-1 text-xs bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-slate-100 outline-none focus:border-cyan-500/50"
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder="Type a message..."
              />
              <button
                className="bg-cyan-500 hover:bg-cyan-600 text-black font-semibold text-xs px-3 rounded-lg flex items-center justify-center disabled:opacity-40 transition-colors"
                type="submit"
                disabled={!manualText.trim()}
              >
                <Send size={14} />
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Voice Selection settings drawer */}
      <div className="absolute top-[72px] left-4 right-4 flex justify-between gap-2 z-10">
        <select
          className="text-[11px] bg-black/60 border border-white/10 rounded-full px-3 py-1 text-slate-300 outline-none"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value="hinglish">Hinglish</option>
          <option value="hindi">Hindi</option>
          <option value="english">English</option>
        </select>

        <select
          className="text-[11px] bg-black/60 border border-white/10 rounded-full px-3 py-1 text-slate-300 outline-none max-w-[120px] truncate"
          value={voiceURI}
          onChange={(e) => setVoiceURI(e.target.value)}
        >
          {voices.length ? voices.map(v => (
            <option key={v.voiceURI} value={v.voiceURI}>{v.name}</option>
          )) : <option value="">System Voice</option>}
        </select>

        <label className="flex items-center gap-1.5 text-[11px] bg-black/60 border border-white/10 rounded-full px-3 py-1 text-slate-300">
          <Volume2 size={11} />
          <input
            className="w-16 accent-cyan-400"
            max="1.4"
            min="0.7"
            step="0.1"
            type="range"
            value={speechRate}
            onChange={(e) => setSpeechRate(Number(e.target.value))}
          />
        </label>
      </div>

      {/* Control row bar */}
      <div className="vibe-controls-bar">
        <button
          className={clsx(
            "p-3 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors",
            cameraActive && "border-cyan-500/35 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20"
          )}
          type="button"
          onClick={handleToggleCamera}
          title="Toggle Camera"
        >
          {cameraActive ? <Camera size={21} /> : <CameraOff size={21} />}
        </button>

        <button
          className="p-3 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors disabled:opacity-40"
          type="button"
          onClick={handleSwitchCamera}
          disabled={!cameraActive}
          title="Flip Camera"
        >
          <RotateCcw size={21} />
        </button>

        {cameraActive && (
          <button
            className="px-5 py-3 rounded-full border border-cyan-500/35 bg-cyan-500/10 text-cyan-400 font-extrabold text-[10px] tracking-wider hover:bg-cyan-500/20 transition-all uppercase"
            type="button"
            onClick={handleManualAnalyze}
            title="Scan object"
          >
            Scan
          </button>
        )}

        <button
          className={clsx(
            "p-3 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition-colors",
            muted && "border-red-500/35 bg-red-500/10 text-red-400 hover:bg-red-500/20"
          )}
          type="button"
          onClick={toggleMute}
          title="Mute Mic"
        >
          {muted ? <MicOff size={21} /> : <Mic size={21} />}
        </button>

        <button className="p-3.5 rounded-full bg-red-600 hover:bg-red-700 text-white transition-colors shadow-lg shadow-red-600/25" type="button" onClick={handleEndCall} title="End Call">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
