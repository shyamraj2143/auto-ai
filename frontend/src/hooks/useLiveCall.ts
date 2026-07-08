import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/client";

export type LiveCallState =
  | "idle"
  | "requesting_permission"
  | "listening"
  | "processing_speech"
  | "thinking"
  | "speaking"
  | "camera_on"
  | "analyzing_vision"
  | "interrupted"
  | "error"
  | "ended";

export interface LiveLine {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

type NativeLiveSpeechPlugin = {
  speak: (options: { text: string; language: string; rate: number }) => Promise<void>;
  stopSpeaking: () => Promise<void>;
};

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

function getLangCode(lang: string) {
  if (lang === "english") return "en-US";
  if (lang === "hindi") return "hi-IN";
  if (lang === "hinglish") return "hi-IN";
  return "hi-IN";
}

interface UseLiveCallProps {
  token: string | null;
  language: string; // "auto" | "hindi" | "english" | "hinglish"
  speechRate: number;
  selectedVoiceURI: string;
  cameraActive: boolean;
  captureAndAnalyzeFrame: (prompt: string, silent: boolean) => Promise<string | null>;
  defaultProvider?: string | null;
  defaultModel?: string | null;
}

export function useLiveCall({
  token,
  language,
  speechRate,
  selectedVoiceURI,
  cameraActive,
  captureAndAnalyzeFrame,
  defaultProvider,
  defaultModel,
}: UseLiveCallProps) {
  const [status, setStatus] = useState<LiveCallState>("idle");
  const [sessionId, setSessionId] = useState("");
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);

  const sessionIdRef = useRef("");
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const statusRef = useRef<LiveCallState>("idle");
  const mutedRef = useRef(false);
  const shouldListenRef = useRef(true);
  const recognitionRef = useRef<any>(null);
  const isRecognitionRunningRef = useRef(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const accumulatedTranscriptRef = useRef("");

  // Sync refs to avoid stale closures in event listeners
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const addLine = useCallback((role: LiveLine["role"], text: string) => {
    if (!text.trim()) return;
    setLines((current) => [
      ...current.slice(-15),
      { id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, role, text: text.trim() }
    ]);
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

  const stopAudioPlayback = useCallback(() => {
    const nativeSpeech = nativeLiveSpeechPlugin();
    if (nativeSpeech) {
      void nativeSpeech.stopSpeaking().catch(() => undefined);
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const speak = useCallback((text: string) => {
    stopAudioPlayback();
    if (!text.trim()) {
      if (shouldListenRef.current && !mutedRef.current) {
        setStatus("listening");
      }
      return;
    }

    const nativeSpeech = nativeLiveSpeechPlugin();
    if (nativeSpeech) {
      setStatus("speaking");
      nativeSpeech.speak({ text, language: getLangCode(language), rate: speechRate })
        .catch((e) => {
          console.error("Native speech failed:", e);
        })
        .finally(() => {
          if (statusRef.current === "speaking") {
            if (shouldListenRef.current && !mutedRef.current) {
              setStatus("listening");
            } else {
              setStatus("idle");
            }
          }
        });
      return;
    }

    if (!("speechSynthesis" in window)) {
      if (shouldListenRef.current && !mutedRef.current) {
        setStatus("listening");
      }
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = speechRate;
    utterance.lang = getLangCode(language);

    if (selectedVoiceURI) {
      const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === selectedVoiceURI);
      if (voice) utterance.voice = voice;
    }

    utterance.onstart = () => {
      setStatus("speaking");
    };

    utterance.onend = () => {
      if (statusRef.current === "speaking") {
        if (shouldListenRef.current && !mutedRef.current) {
          setStatus("listening");
        } else {
          setStatus("idle");
        }
      }
    };

    utterance.onerror = (e) => {
      console.error("TTS failed:", e);
      if (statusRef.current === "speaking") {
        if (shouldListenRef.current && !mutedRef.current) {
          setStatus("listening");
        } else {
          setStatus("idle");
        }
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [language, selectedVoiceURI, speechRate, stopAudioPlayback]);

  // Clean up timers
  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  // Triggers API call to get answer
  const triggerResponse = useCallback(async (text: string) => {
    if (!token || !text.trim()) return;
    stopAudioPlayback();
    addLine("user", text);
    setStatus("processing_speech");
    setError("");

    let contextId = null;

    // Detect if this is a visual query while camera is active
    const visualKeywords = [
      "ye kya", "yeh kya", "yee kya", "ye vala", "yeh vala",
      "what is this", "what's this", "what is that", "what's that",
      "look at this", "look at that", "see this", "can you see",
      "what do you see", "ispe kya", "dekho", "dekhna", "dekh",
      "show you", "identify", "analyze this", "ye kaisa", "yeh kaisa"
    ];
    const isVisualQuery = cameraActive && visualKeywords.some(keyword => 
      text.toLowerCase().includes(keyword)
    );

    if (isVisualQuery) {
      setStatus("analyzing_vision");
      contextId = await captureAndAnalyzeFrame(`Use this camera frame to answer: ${text}`, true);
    }

    setStatus("thinking");

    try {
      const sid = await ensureSession();
      // Call sendLiveMessage with the updated backend structure
      const result = await api.sendLiveMessage(token, {
        session_id: sid,
        text: text, // mapping transcript -> text
        camera_context_id: contextId, // mapping image_frame_id -> camera_context_id
        provider: defaultProvider,
        model: defaultModel,
        language
      });

      // Get response text from result
      const answer = result.answer || result.response_text || "";
      addLine("assistant", answer);
      speak(answer);
    } catch (e: any) {
      console.error("Failed to fetch backend response:", e);
      setError(e.message || "Connection interrupted. Tap to retry.");
      setStatus("error");
    }
  }, [token, cameraActive, captureAndAnalyzeFrame, ensureSession, addLine, speak, defaultModel, defaultProvider, language, stopAudioPlayback]);

  // Instant voice interruption handler
  const handleInterruption = useCallback(() => {
    if (statusRef.current !== "speaking") return;
    console.log("Interruption detected: user started speaking.");
    stopAudioPlayback();
    setStatus("interrupted");
    setTimeout(() => {
      if (shouldListenRef.current && !mutedRef.current) {
        setStatus("listening");
      }
    }, 200);
  }, [stopAudioPlayback]);

  // Configure Speech Recognition
  const startRecognition = useCallback(() => {
    if (isRecognitionRunningRef.current || !shouldListenRef.current || mutedRef.current) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("SpeechRecognition not supported in this browser.");
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = getLangCode(language);

    rec.onstart = () => {
      isRecognitionRunningRef.current = true;
    };

    rec.onresult = (event: any) => {
      // If AI is speaking, user speaking is an interruption!
      if (statusRef.current === "speaking") {
        handleInterruption();
        return;
      }

      clearSilenceTimer();

      let finalTranscript = "";
      let interim = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      if (interim) {
        setInterimTranscript(interim);
      }

      if (finalTranscript.trim()) {
        accumulatedTranscriptRef.current += " " + finalTranscript.trim();
      }

      // 1.5s Silence detection
      silenceTimerRef.current = setTimeout(() => {
        const textToSend = accumulatedTranscriptRef.current.trim() || interim.trim();
        if (textToSend) {
          accumulatedTranscriptRef.current = "";
          setInterimTranscript("");
          void triggerResponse(textToSend);
        }
      }, 1500);
    };

    rec.onspeechstart = () => {
      if (statusRef.current === "speaking") {
        handleInterruption();
      }
    };

    rec.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        setError("Microphone permission is required for Live Mode.");
        setStatus("error");
      } else if (event.error !== "no-speech") {
        setError("I could not hear clearly. Please say that again.");
        setTimeout(() => {
          if (statusRef.current === "error") {
            setStatus("listening");
          }
        }, 3000);
      }
    };

    rec.onend = () => {
      isRecognitionRunningRef.current = false;
      // Auto restart if call is still active
      if (shouldListenRef.current && !mutedRef.current && statusRef.current === "listening") {
        try {
          rec.start();
        } catch (e) {
          console.error("Failed to restart speech recognition:", e);
        }
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      console.error("Failed to start speech recognition:", e);
    }
  }, [language, triggerResponse, handleInterruption]);

  const stopRecognition = useCallback(() => {
    clearSilenceTimer();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // already stopped
      }
      recognitionRef.current = null;
    }
    isRecognitionRunningRef.current = false;
  }, []);

  const initializeMic = useCallback(async () => {
    setError("");
    setStatus("requesting_permission");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatus("listening");
      startRecognition();
    } catch (err) {
      console.error("Microphone permission denied:", err);
      setError("Microphone permission is required for Live Mode.");
      setStatus("error");
    }
  }, [startRecognition]);

  // Handle Mute/Unmute
  const toggleMute = useCallback(() => {
    if (muted) {
      setMuted(false);
      mutedRef.current = false;
      shouldListenRef.current = true;
      setStatus("listening");
      startRecognition();
    } else {
      setMuted(true);
      mutedRef.current = true;
      shouldListenRef.current = false;
      stopRecognition();
      stopAudioPlayback();
      setStatus("idle");
    }
  }, [muted, startRecognition, stopRecognition, stopAudioPlayback]);

  // Restart session or retry when failed
  const retryCall = useCallback(() => {
    setError("");
    setStatus("listening");
    startRecognition();
  }, [startRecognition]);

  // End Call
  const endCall = useCallback(async () => {
    shouldListenRef.current = false;
    stopRecognition();
    stopAudioPlayback();
    setStatus("ended");

    if (token && sessionIdRef.current) {
      await api.endLiveSession(token, sessionIdRef.current).catch(() => undefined);
    }
  }, [token, stopRecognition, stopAudioPlayback]);

  // Start call on mount
  useEffect(() => {
    shouldListenRef.current = true;
    void ensureSession()
      .then(() => {
        void initializeMic();
      })
      .catch((err) => {
        console.error("Failed to establish session:", err);
        setError("Connection interrupted. Tap to retry.");
        setStatus("error");
      });

    return () => {
      shouldListenRef.current = false;
      stopRecognition();
      stopAudioPlayback();
    };
  }, [ensureSession, initializeMic, stopRecognition, stopAudioPlayback]);

  // Re-start recognition if language changes
  useEffect(() => {
    if (status === "listening") {
      stopRecognition();
      setTimeout(() => {
        if (shouldListenRef.current && !mutedRef.current) {
          startRecognition();
        }
      }, 300);
    }
  }, [language, startRecognition, stopRecognition]);

  return {
    status,
    sessionId,
    lines,
    interimTranscript,
    error,
    muted,
    toggleMute,
    retryCall,
    triggerResponse,
    endCall,
    addLine,
  };
}
