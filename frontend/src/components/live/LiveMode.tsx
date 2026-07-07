import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Camera, CameraOff, FileUp, MessageSquareText, Mic, MicOff, PhoneOff, RefreshCw, RotateCcw, Send, Volume2, VolumeX, X } from "lucide-react";
import clsx from "clsx";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";
import { useAppSettings } from "../../contexts/AppSettingsContext";

type LiveStatus = "connecting" | "listening" | "thinking" | "speaking" | "connection_lost" | "muted" | "looking" | "analyzing";
type LiveLine = { id: string; role: "user" | "assistant" | "system"; text: string };

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onspeechstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type NativeLiveSpeechPlugin = {
  startListening: (options: { language: string }) => Promise<{ text?: string }>;
  speak: (options: { text: string; language: string; rate: number }) => Promise<void>;
  stopSpeaking: () => Promise<void>;
};

const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4"
];

function supportedRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  return RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function audioFilename(mimeType: string) {
  if (mimeType.includes("ogg")) return "live-voice.ogg";
  if (mimeType.includes("mp4")) return "live-voice.m4a";
  return "live-voice.webm";
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const win = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function nativeLiveSpeechPlugin(): NativeLiveSpeechPlugin | null {
  const win = window as typeof window & {
    Capacitor?: {
      getPlatform?: () => string;
      Plugins?: { AutoAiLiveSpeech?: NativeLiveSpeechPlugin };
    };
  };
  return win.Capacitor?.getPlatform?.() === "android"
    ? win.Capacitor?.Plugins?.AutoAiLiveSpeech ?? null
    : null;
}

function languageToSpeechCode(language: string) {
  if (language === "english") return "en-US";
  if (language === "hindi") return "hi-IN";
  return "hi-IN";
}

function statusLabel(status: LiveStatus) {
  return {
    connecting: "Connecting...",
    listening: "Listening...",
    thinking: "Thinking...",
    speaking: "Speaking...",
    connection_lost: "Connection lost",
    muted: "Mic muted",
    looking: "Looking...",
    analyzing: "Analyzing image..."
  }[status];
}

export function LiveMode({ onClose }: { onClose: () => void }) {
  const { token, user } = useAuth();
  const { settings } = useAppSettings();
  const [sessionId, setSessionId] = useState("");
  const sessionIdRef = useRef("");
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const sendUserTextRef = useRef<(text: string) => void>(() => undefined);
  const recognitionActiveRef = useRef(false);
  const nativeListeningRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fallbackTimerRef = useRef<number | null>(null);
  const recorderManualStopRef = useRef(false);
  const shouldListenRef = useRef(true);
  const speakingRef = useRef(false);
  const mutedRef = useRef(false);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const captureInFlightRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<"user" | "environment">("environment");
  const [liveVision, setLiveVision] = useState(false);
  const [lastFrameId, setLastFrameId] = useState<string | null>(null);
  const [faceMemoryEnabled, setFaceMemoryEnabled] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [speechRate, setSpeechRate] = useState(1);
  const [language, setLanguage] = useState("auto");
  const [manualText, setManualText] = useState("");

  const selectedVoice = useMemo(
    () => voices.find((voice) => voice.voiceURI === voiceURI) ?? null,
    [voiceURI, voices]
  );

  const addLine = useCallback((role: LiveLine["role"], text: string) => {
    if (!text.trim()) return;
    setLines((current) => [...current.slice(-12), { id: makeId(), role, text: text.trim() }]);
  }, []);

  const stopSpeaking = useCallback(() => {
    void nativeLiveSpeechPlugin()?.stopSpeaking().catch(() => undefined);
    speakingRef.current = false;
    if (!mutedRef.current) setStatus("listening");
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
  }, []);

  const ensureSession = useCallback(async () => {
    if (!token) throw new Error("Not authenticated");
    if (sessionIdRef.current) return sessionIdRef.current;
    if (sessionPromiseRef.current) return sessionPromiseRef.current;
    sessionPromiseRef.current = api.startLiveSession(token).then((session) => {
      sessionIdRef.current = session.session_id;
      setSessionId(session.session_id);
      return session.session_id;
    });
    try {
      return await sessionPromiseRef.current;
    } finally {
      sessionPromiseRef.current = null;
    }
  }, [token]);

  const stopFallbackRecording = useCallback((manual = true) => {
    recorderManualStopRef.current = manual;
    if (fallbackTimerRef.current) {
      window.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      if (recorder.state === "recording") recorder.requestData();
      recorder.stop();
    }
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  }, []);

  const startFallbackRecording = useCallback(async () => {
    if (!token || mutedRef.current || typeof MediaRecorder === "undefined") {
      setStatus("connection_lost");
      setError("Microphone permission is required for Live Mode.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = supportedRecorderMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioStreamRef.current = stream;
      audioChunksRef.current = [];
      recorderManualStopRef.current = false;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        setStatus("connection_lost");
        setError("Connection interrupted. Trying again...");
        stopFallbackRecording();
      };
      recorder.onstop = async () => {
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        let sentTranscript = false;
        stream.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
        if (!recorderManualStopRef.current && chunks.length) {
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            if (blob.size > 800) {
              const result = await api.transcribeAudio(token, blob, audioFilename(blob.type));
              if (result.text.trim()) {
                sentTranscript = true;
                sendUserTextRef.current(result.text.trim());
              }
            }
          } catch {
            setError("Connection interrupted. Trying again...");
          }
        }
        if (shouldListenRef.current && !sentTranscript && !mutedRef.current && !speakingRef.current && !recorderManualStopRef.current) {
          window.setTimeout(() => {
            void startFallbackRecording();
          }, 250);
        }
      };
      recorder.start(1000);
      setStatus("listening");
      fallbackTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, 4200);
    } catch {
      setStatus("connection_lost");
      setError("Microphone permission is required for Live Mode.");
    }
  }, [stopFallbackRecording, token]);

  const startListening = useCallback(async () => {
    setError("");
    if (!token || mutedRef.current) return;
    const nativeSpeech = nativeLiveSpeechPlugin();
    if (nativeSpeech && !nativeListeningRef.current) {
      nativeListeningRef.current = true;
      setStatus("listening");
      try {
        const result = await nativeSpeech.startListening({ language: languageToSpeechCode(language) });
        const text = (result.text || "").trim();
        if (text) {
          sendUserTextRef.current(text);
        } else if (shouldListenRef.current && !mutedRef.current && !speakingRef.current) {
          window.setTimeout(() => void startListening(), 450);
        }
      } catch {
        setError("No speech detected. Tap mic or type a message.");
      } finally {
        nativeListeningRef.current = false;
      }
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      await startFallbackRecording();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      setStatus("connection_lost");
      setError("Microphone permission is required for Live Mode.");
      return;
    }
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = languageToSpeechCode(language);
    recognition.onstart = () => {
      recognitionActiveRef.current = true;
      if (!speakingRef.current) setStatus("listening");
    };
    recognition.onspeechstart = () => {
      if (speakingRef.current) stopSpeaking();
    };
    recognition.onerror = (event) => {
      recognitionActiveRef.current = false;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Microphone permission is required for Live Mode.");
      } else {
        setError("Connection interrupted. Trying again...");
      }
      setStatus("connection_lost");
    };
    recognition.onend = () => {
      recognitionActiveRef.current = false;
      if (shouldListenRef.current && !mutedRef.current && !speakingRef.current) {
        window.setTimeout(() => {
          try {
            recognition.start();
          } catch {
            setStatus("connection_lost");
          }
        }, 350);
      }
    };
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += text;
        else interimText += text;
      }
      setInterimTranscript(interimText.trim());
      if (finalText.trim()) {
        setInterimTranscript("");
        sendUserTextRef.current(finalText.trim());
      }
    };
    recognitionRef.current = recognition;
    try {
      shouldListenRef.current = true;
      recognition.start();
    } catch {
      setStatus("connection_lost");
      setError("Could not start microphone.");
    }
  }, [language, startFallbackRecording, stopSpeaking, token]);

  const speak = useCallback((text: string) => {
    const nativeSpeech = nativeLiveSpeechPlugin();
    if (nativeSpeech && text.trim()) {
      recognitionRef.current?.abort();
      stopFallbackRecording();
      speakingRef.current = true;
      setStatus("speaking");
      nativeSpeech.speak({ text, language: languageToSpeechCode(language), rate: speechRate })
        .catch(() => undefined)
        .finally(() => {
          speakingRef.current = false;
          if (!mutedRef.current) {
            setStatus("listening");
            void startListening();
          }
        });
      return;
    }
    if (!("speechSynthesis" in window) || !text.trim()) {
      if (!muted) setStatus("listening");
      return;
    }
    window.speechSynthesis.cancel();
    stopFallbackRecording();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speechRate;
    utterance.lang = selectedVoice?.lang || languageToSpeechCode(language);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.onstart = () => {
      speakingRef.current = true;
      setStatus("speaking");
    };
    utterance.onend = () => {
      speakingRef.current = false;
      if (!muted) {
        setStatus("listening");
        void startListening();
      }
    };
    utterance.onerror = () => {
      speakingRef.current = false;
      if (!muted) {
        setStatus("listening");
        void startListening();
      }
    };
    window.speechSynthesis.speak(utterance);
  }, [language, muted, selectedVoice, speechRate, startListening, stopFallbackRecording]);

  const captureVideoBlob = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  }, []);

  const analyzeBlob = useCallback(async (blob: Blob, prompt: string, silent = false) => {
    if (!token || !blob.size || captureInFlightRef.current) return null;
    captureInFlightRef.current = true;
    if (!silent) setStatus("analyzing");
    try {
      const sid = await ensureSession();
      const formData = new FormData();
      formData.append("session_id", sid);
      formData.append("prompt", prompt);
      formData.append("file", blob, "live-frame.jpg");
      const result = await api.analyzeLiveVision(token, formData);
      setLastFrameId(result.frame_id);
      if (!silent) addLine("assistant", result.analysis_summary);
      return result.frame_id;
    } catch {
      setError("Connection interrupted. Trying again...");
      setStatus("connection_lost");
      return null;
    } finally {
      captureInFlightRef.current = false;
      if (!silent && !muted) setStatus("listening");
    }
  }, [addLine, ensureSession, muted, token]);

  const captureAndAnalyze = useCallback(async (prompt = "Analyze what is visible right now.", silent = false) => {
    const blob = await captureVideoBlob();
    if (!blob) {
      if (!silent) setError("Camera preview is not ready.");
      return null;
    }
    return analyzeBlob(blob, prompt, silent);
  }, [analyzeBlob, captureVideoBlob]);

  const sendUserText = useCallback(async (text: string) => {
    if (!token || !text.trim()) return;
    stopSpeaking();
    addLine("user", text);
    setStatus("thinking");
    setError("");
    let frameId = lastFrameId;
    if (cameraActive && !frameId) {
      frameId = await captureAndAnalyze(`Use this camera frame to answer: ${text}`, true);
    }
    try {
      const sid = await ensureSession();
      const result = await api.sendLiveMessage(token, {
        session_id: sid,
        transcript: text,
        image_frame_id: frameId,
        provider: settings.defaultProvider,
        model: settings.defaultModel,
        language
      });
      addLine("assistant", result.response_text);
      speak(result.response_text);
    } catch {
      setError("Connection interrupted. Trying again...");
      setStatus("connection_lost");
    }
  }, [
    addLine,
    cameraActive,
    captureAndAnalyze,
    ensureSession,
    language,
    lastFrameId,
    settings.defaultModel,
    settings.defaultProvider,
    speak,
    stopSpeaking,
    token
  ]);

  useEffect(() => {
    sendUserTextRef.current = (text: string) => {
      void sendUserText(text);
    };
  }, [sendUserText]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const startCamera = useCallback(async (facing: "user" | "environment" = cameraFacing) => {
    setError("");
    try {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing },
        audio: false
      });
      cameraStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraFacing(facing);
      setCameraActive(true);
      setStatus("looking");
    } catch {
      setError("Camera permission is required for Vision Mode.");
      setStatus("connection_lost");
    }
  }, [cameraFacing]);

  const stopCamera = useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    setLiveVision(false);
    setLastFrameId(null);
    if (!muted) setStatus("listening");
  }, [muted]);

  const maybeEnrollFaceMemory = useCallback(async () => {
    if (!token || faceMemoryEnabled || cameraFacing !== "user" || !cameraActive) return;
    const consent = window.confirm("Do you want Auto-AI to remember your face for a more personal experience?");
    if (!consent) return;
    const blob = await captureVideoBlob();
    if (!blob) return;
    const formData = new FormData();
    formData.append("consent_given", "true");
    formData.append("file", blob, "face-memory.jpg");
    try {
      const result = await api.enrollFaceMemory(token, formData);
      setFaceMemoryEnabled(result.enabled);
      addLine("system", "Face memory enabled for your logged-in profile.");
    } catch {
      setError("Could not save face memory.");
    }
  }, [addLine, cameraActive, cameraFacing, captureVideoBlob, faceMemoryEnabled, token]);

  useEffect(() => {
    void maybeEnrollFaceMemory();
  }, [maybeEnrollFaceMemory]);

  useEffect(() => {
    if (!token) return;
    void ensureSession()
      .then(() => {
        setStatus("listening");
        void startListening();
      })
      .catch(() => {
        setStatus("connection_lost");
        setError("Connection interrupted. Trying again...");
      });
    void api.faceMemoryStatus(token).then((result) => {
      setFaceMemoryEnabled(result.enabled);
      if (result.enabled && user?.name) addLine("assistant", `Hi ${user.name}, welcome back.`);
    }).catch(() => undefined);
    const loadVoices = () => {
      if (!("speechSynthesis" in window)) return;
      const nextVoices = window.speechSynthesis.getVoices();
      setVoices(nextVoices);
      setVoiceURI((current) => current || nextVoices[0]?.voiceURI || "");
    };
    loadVoices();
    if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;
    return () => {
      shouldListenRef.current = false;
      recognitionRef.current?.abort();
      stopFallbackRecording();
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, [addLine, ensureSession, startListening, stopFallbackRecording, token, user?.name]);

  useEffect(() => {
    if (!liveVision || !cameraActive) return;
    const timer = window.setInterval(() => {
      void captureAndAnalyze("Live vision update. Briefly summarize meaningful visible changes.", true);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [cameraActive, captureAndAnalyze, liveVision]);

  async function toggleMute() {
    if (muted) {
      setMuted(false);
      mutedRef.current = false;
      shouldListenRef.current = true;
      await startListening();
      return;
    }
    setMuted(true);
    mutedRef.current = true;
    shouldListenRef.current = false;
    nativeListeningRef.current = false;
    recognitionRef.current?.abort();
    stopFallbackRecording();
    setStatus("muted");
  }

  async function switchCamera() {
    const next = cameraFacing === "user" ? "environment" : "user";
    await startCamera(next);
  }

  async function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await analyzeBlob(file, "Analyze this uploaded visual context for the live conversation.");
  }

  async function submitManualText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    setManualText("");
    await sendUserText(text);
  }

  async function deleteFaceMemory() {
    if (!token) return;
    await api.deleteFaceMemory(token);
    setFaceMemoryEnabled(false);
    addLine("system", "Face memory deleted.");
  }

  async function endCall() {
    shouldListenRef.current = false;
    nativeListeningRef.current = false;
    recognitionRef.current?.abort();
    stopFallbackRecording();
    stopSpeaking();
    stopCamera();
    if (token && sessionIdRef.current) {
      await api.endLiveSession(token, sessionIdRef.current).catch(() => undefined);
    }
    onClose();
  }

  return (
    <div className="live-mode-shell" role="dialog" aria-modal="true">
      <div className="live-mode-topbar">
        <button className="live-icon-button" type="button" onClick={endCall} title="Back">
          <X size={20} />
        </button>
        <div className="live-mode-title">
          <span>Auto-AI Live</span>
          <strong>{statusLabel(status)}</strong>
        </div>
        <button className="live-icon-button" type="button" onClick={onClose} title="Chat">
          <MessageSquareText size={20} />
        </button>
      </div>

      <main className="live-mode-main">
        <section className={clsx("live-orb-zone", status === "speaking" && "live-orb-speaking", status === "thinking" && "live-orb-thinking")}>
          <div className="live-orb">
            <span />
            <span />
            <span />
          </div>
          <p className="live-status-text">{statusLabel(status)}</p>
          {error && <p className="live-error-text">{error}</p>}
          {interimTranscript && <p className="live-interim">{interimTranscript}</p>}
        </section>

        <section className="live-camera-panel" aria-hidden={!cameraActive}>
          <video ref={videoRef} className={clsx(!cameraActive && "hidden")} playsInline muted />
          {!cameraActive && <div className="live-camera-empty">Vision paused</div>}
          {cameraActive && <span className="live-camera-chip">{cameraFacing === "user" ? "Front camera" : "Back camera"}</span>}
        </section>

        <section className="live-transcript">
          {lines.map((line) => (
            <p key={line.id} className={`live-line live-line-${line.role}`}>
              {line.text}
            </p>
          ))}
        </section>

        <form className="live-manual-form" onSubmit={submitManualText}>
          <input
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder="Type if voice is not detected..."
            aria-label="Live message"
          />
          <button type="submit" disabled={!manualText.trim()} title="Send live message">
            <Send size={17} />
          </button>
        </form>

        <section className="live-settings-row">
          <select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="Live language">
            <option value="auto">Auto</option>
            <option value="hindi">Hindi</option>
            <option value="english">English</option>
            <option value="hinglish">Hinglish</option>
          </select>
          <select value={voiceURI} onChange={(event) => setVoiceURI(event.target.value)} aria-label="Voice">
            {voices.length ? voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name}</option>
            )) : <option value="">Default voice</option>}
          </select>
          <label>
            <Volume2 size={15} />
            <input
              aria-label="Speech speed"
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

      <input ref={fileInputRef} className="hidden" type="file" accept="image/*" onChange={handleFileSelection} />

      <div className="live-bottom-controls">
        <button className={clsx("live-control", cameraActive && "live-control-active")} type="button" onClick={() => cameraActive ? stopCamera() : startCamera("environment")} title={cameraActive ? "Turn camera off" : "Camera"}>
          {cameraActive ? <CameraOff size={21} /> : <Camera size={21} />}
        </button>
        <button className="live-control" type="button" onClick={() => fileInputRef.current?.click()} title="Upload visual">
          <FileUp size={21} />
        </button>
        <button className="live-control" type="button" onClick={switchCamera} disabled={!cameraActive} title="Switch camera">
          <RotateCcw size={21} />
        </button>
        <button className={clsx("live-control", liveVision && "live-control-active")} type="button" onClick={() => setLiveVision((current) => !current)} disabled={!cameraActive} title="Live vision">
          <RefreshCw size={21} />
        </button>
        <button className={clsx("live-control", muted && "live-control-danger")} type="button" onClick={toggleMute} title={muted ? "Unmute mic" : "Mute mic"}>
          {muted ? <MicOff size={21} /> : <Mic size={21} />}
        </button>
        <button className="live-control" type="button" onClick={stopSpeaking} title="Stop speaking">
          <VolumeX size={21} />
        </button>
        <button className="live-control live-end-call" type="button" onClick={endCall} title="End call">
          <PhoneOff size={22} />
        </button>
      </div>

      <div className="live-privacy-row">
        <span>{faceMemoryEnabled ? "Face Memory enabled" : "Face Memory disabled"}</span>
        {faceMemoryEnabled && <button type="button" onClick={deleteFaceMemory}>Delete Face Memory</button>}
      </div>
    </div>
  );
}
