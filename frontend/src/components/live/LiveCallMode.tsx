import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, CameraOff, MessageSquareText, Mic, MicOff, PhoneOff, RotateCcw, Send, Volume2, X } from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../../contexts/AuthContext";
import { useAppSettings } from "../../contexts/AppSettingsContext";
import { useCameraVision } from "../../hooks/useCameraVision";
import { useLiveCall } from "../../hooks/useLiveCall";
import { api } from "../../api/client";

function statusLabel(status: string) {
  switch (status) {
    case "requesting_permission":
      return "Connecting...";
    case "listening":
      return "Listening...";
    case "processing_speech":
    case "thinking":
      return "Thinking...";
    case "speaking":
      return "Speaking...";
    case "analyzing_vision":
      return "Looking...";
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

  // State values for speech customization
  const [language, setLanguage] = useState("auto");
  const [speechRate, setSpeechRate] = useState(1);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [manualText, setManualText] = useState("");
  const [showTranscriptDrawer, setShowTranscriptDrawer] = useState(false);

  // Initialize camera hook
  const {
    cameraActive,
    cameraFacing,
    cameraError,
    setCameraError,
    startCamera,
    stopCamera,
    switchCamera,
    captureFrame,
  } = useCameraVision();

  // Create an on-demand frame analyzer function to pass into useLiveCall
  const captureAndAnalyzeFrame = useCallback(
    async (prompt: string, silent: boolean): Promise<string | null> => {
      if (!token) return null;
      const blob = await captureFrame(videoRef.current);
      if (!blob) {
        if (!silent) setCameraError("Camera preview is not ready.");
        return null;
      }
      try {
        const sid = api.startLiveSession(token); // retrieve or start session
        const formData = new FormData();
        formData.append("session_id", sid ? await sid.then((s) => s.session_id) : "");
        formData.append("prompt", prompt);
        formData.append("file", blob, "live-frame.jpg");
        const result = await api.analyzeLiveVision(token, formData);
        return result.frame_id;
      } catch (err) {
        console.error("Frame analysis failed:", err);
        return null;
      }
    },
    [token, captureFrame, setCameraError]
  );

  // Initialize live voice call hook
  const {
    status,
    lines,
    interimTranscript,
    error,
    muted,
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
    defaultProvider: settings.defaultProvider,
    defaultModel: settings.defaultModel,
  });

  // Load available speech synthesis voices
  useEffect(() => {
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) return;
      const nextVoices = window.speechSynthesis.getVoices();
      setVoices(nextVoices);
      setVoiceURI((current) => current || nextVoices[0]?.voiceURI || "");
    };
    loadVoices();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);

  // Handle camera toggles
  const handleToggleCamera = async () => {
    if (cameraActive) {
      stopCamera(videoRef.current);
    } else {
      try {
        await startCamera(cameraFacing, videoRef.current);
      } catch (e) {
        // Handled in Hook (cameraError)
      }
    }
  };

  // Manual image analysis capture
  const handleManualAnalyze = async () => {
    if (!cameraActive) return;
    addLine("system", "Analyzing current frame...");
    const frameId = await captureAndAnalyzeFrame("Analyze what is visible and summarize clearly.", false);
    if (frameId) {
      try {
        const sid = await api.startLiveSession(token!);
        const result = await api.sendLiveMessage(token!, {
          session_id: sid.session_id,
          text: "What do you see in this image?",
          camera_context_id: frameId,
          provider: settings.defaultProvider,
          model: settings.defaultModel,
          language,
        });
        const answer = result.answer || result.response_text || "";
        addLine("assistant", answer);
        if ("speechSynthesis" in window) {
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(answer);
          utterance.rate = speechRate;
          utterance.lang = language === "english" ? "en-US" : "hi-IN";
          if (voiceURI) {
            const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
            if (voice) utterance.voice = voice;
          }
          window.speechSynthesis.speak(utterance);
        }
      } catch (e) {
        console.error("Manual analysis messaging failed:", e);
      }
    }
  };

  // Form submission for typing if voice is not detected
  const handleSubmitManualText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    await triggerResponse(text);
  };

  // Switch between front and back camera
  const handleSwitchCamera = async () => {
    if (!cameraActive) return;
    await switchCamera(videoRef.current);
  };

  // Wrap ending of the call
  const handleEndCall = async () => {
    await endCall();
    stopCamera(videoRef.current);
    onClose();
  };

  return (
    <div className={clsx("live-mode-shell", cameraActive && "live-mode-camera-on")} role="dialog" aria-modal="true">
      {/* Top Controls */}
      <div className="live-mode-topbar">
        <button className="live-icon-button" type="button" onClick={handleEndCall} title="Back">
          <X size={20} />
        </button>
        <div className="live-mode-title">
          <span>Auto-AI Live Call</span>
          <strong>{statusLabel(status)}</strong>
        </div>
        <button
          className={clsx("live-icon-button", showTranscriptDrawer && "live-control-active")}
          type="button"
          onClick={() => setShowTranscriptDrawer((prev) => !prev)}
          title="Transcript"
        >
          <MessageSquareText size={20} />
        </button>
      </div>

      {/* Main Call View */}
      <main className="live-mode-main">
        {/* Animated Avatar / Orb (shows in center or top right depending on camera state) */}
        <section
          className={clsx(
            "live-orb-zone",
            status === "speaking" && "live-orb-speaking",
            (status === "thinking" || status === "processing_speech" || status === "analyzing_vision") && "live-orb-thinking"
          )}
        >
          <div className="live-orb">
            <span />
            <span />
            <span />
          </div>
          <p className="live-status-text">{statusLabel(status)}</p>
          {(error || cameraError) && (
            <p className="live-error-text" onClick={retryCall}>
              {error || cameraError}
            </p>
          )}
          {interimTranscript && <p className="live-interim">{interimTranscript}</p>}
        </section>

        {/* Camera Preview Panel */}
        <section className="live-camera-panel" aria-hidden={!cameraActive}>
          <video ref={videoRef} className={clsx(!cameraActive && "hidden")} playsInline muted />
          {!cameraActive && <div className="live-camera-empty">Camera is off</div>}
          {cameraActive && <span className="live-camera-chip">{cameraFacing === "user" ? "Front Camera" : "Back Camera"}</span>}
        </section>

        {/* Small Live Transcript (always shown at bottom of the main section) */}
        <section className="live-transcript">
          {lines.slice(-4).map((line) => (
            <p key={line.id} className={`live-line live-line-${line.role}`}>
              {line.text}
            </p>
          ))}
        </section>

        {/* Text Input Composer */}
        <form className="live-manual-form" onSubmit={handleSubmitManualText}>
          <input
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder="Type a message if mic is silent..."
            aria-label="Type message"
          />
          <button type="submit" disabled={!manualText.trim()} title="Send message">
            <Send size={17} />
          </button>
        </form>

        {/* Call Customizations Row */}
        <section className="live-settings-row">
          <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Call language">
            <option value="auto">Language: Auto</option>
            <option value="hindi">Hindi</option>
            <option value="english">English</option>
            <option value="hinglish">Hinglish</option>
          </select>

          <select value={voiceURI} onChange={(event) => setVoiceURI(event.target.value)} aria-label="Select voice">
            {voices.length ? (
              voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name}
                </option>
              ))
            ) : (
              <option value="">Default System Voice</option>
            )}
          </select>

          <label>
            <Volume2 size={15} />
            <input
              aria-label="Speech Speed"
              max="1.4"
              min="0.7"
              step="0.1"
              type="range"
              value={speechRate}
              onChange={(event) => setSpeechRate(Number(event.target.value))}
            />
          </label>
        </section>
      </main>

      {/* Transcript Drawer Overlay (If open, slides from the side or overlays right) */}
      {showTranscriptDrawer && (
        <div className="fixed inset-0 z-[130] flex justify-end bg-black/60 backdrop-blur-sm" onClick={() => setShowTranscriptDrawer(false)}>
          <div
            className="w-full max-w-md h-full bg-slate-900 border-l border-slate-800 text-slate-100 flex flex-col p-6 overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-4 border-b border-slate-800 mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <MessageSquareText size={20} />
                Live Transcript Log
              </h2>
              <button
                className="p-1 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
                type="button"
                onClick={() => setShowTranscriptDrawer(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {lines.length === 0 ? (
                <p className="text-slate-400 text-center py-8">No messages recorded in this live session yet.</p>
              ) : (
                lines.map((line) => (
                  <div key={line.id} className={clsx("flex flex-col gap-1 max-w-[85%]", line.role === "user" ? "ml-auto items-end" : "mr-auto items-start")}>
                    <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                      {line.role === "user" ? "You" : line.role === "assistant" ? "Auto-AI" : "System"}
                    </span>
                    <p
                      className={clsx(
                        "rounded-xl px-4 py-2.5 text-sm leading-relaxed",
                        line.role === "user"
                          ? "bg-cyan-500/20 text-cyan-50 border border-cyan-500/30 rounded-tr-none"
                          : line.role === "assistant"
                          ? "bg-slate-800 text-slate-100 border border-slate-700/60 rounded-tl-none"
                          : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-center text-xs"
                      )}
                    >
                      {line.text}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom Controls */}
      <div className="live-bottom-controls">
        <button
          className={clsx("live-control", cameraActive && "live-control-active")}
          type="button"
          onClick={handleToggleCamera}
          title={cameraActive ? "Turn Camera Off" : "Turn Camera On"}
        >
          {cameraActive ? <CameraOff size={21} /> : <Camera size={21} />}
        </button>

        <button
          className="live-control"
          type="button"
          onClick={handleSwitchCamera}
          disabled={!cameraActive}
          title="Switch Camera (Front/Back)"
        >
          <RotateCcw size={21} />
        </button>

        <button
          className="live-control"
          type="button"
          onClick={handleManualAnalyze}
          disabled={!cameraActive || status === "analyzing_vision"}
          title="Analyze Camera Object/Screen"
        >
          <span className="text-[10px] font-extrabold uppercase px-1">Scan</span>
        </button>

        <button
          className={clsx("live-control", muted && "live-control-danger")}
          type="button"
          onClick={toggleMute}
          title={muted ? "Unmute Microphone" : "Mute Microphone"}
        >
          {muted ? <MicOff size={21} /> : <Mic size={21} />}
        </button>

        <button className="live-control live-end-call" type="button" onClick={handleEndCall} title="End Call">
          <PhoneOff size={22} />
        </button>
      </div>
    </div>
  );
}
