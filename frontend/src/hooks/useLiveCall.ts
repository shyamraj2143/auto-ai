import { useState, useEffect, useRef, useCallback } from "react";
import { api, API_BASE_URL } from "../api/client";
import { useTranscript } from "./useTranscript";

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

function getLangCode(lang: string) {
  if (lang === "english") return "en-US";
  if (lang === "hindi") return "hi-IN";
  if (lang === "hinglish") return "hi-IN";
  return "hi-IN";
}

interface UseLiveCallProps {
  token: string | null;
  language: string;
  speechRate: number;
  selectedVoiceURI: string;
  cameraActive: boolean;
  captureAndAnalyzeFrame: (prompt: string, silent: boolean) => Promise<string | null>;
  captureBase64Frame: () => Promise<string | null>;
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
  captureBase64Frame,
  defaultProvider,
  defaultModel,
}: UseLiveCallProps) {
  const [status, setStatus] = useState<LiveCallState>("idle");
  const [sessionId, setSessionId] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);

  // Use integrated transcript log hook
  const { lines, addLine, clearTranscripts, scrollRef } = useTranscript();

  const sessionIdRef = useRef("");
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const statusRef = useRef<LiveCallState>("idle");
  const mutedRef = useRef(false);
  const shouldListenRef = useRef(true);
  const recognitionRef = useRef<any>(null);
  const isRecognitionRunningRef = useRef(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const accumulatedTranscriptRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Sync refs to avoid stale closures in event listeners
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

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
    // Stop local SpeechSynthesis
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    // Stop Audio element stream playback
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.src = "";
      } catch (e) {
        // already paused/empty
      }
      audioRef.current = null;
    }
  }, []);

  // Browser Synthesis Fallback
  const speakLocalTts = useCallback((text: string) => {
    if (!("speechSynthesis" in window) || !text.trim()) {
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
      console.error("Local SpeechSynthesis failed:", e);
      if (statusRef.current === "speaking") {
        if (shouldListenRef.current && !mutedRef.current) {
          setStatus("listening");
        } else {
          setStatus("idle");
        }
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [language, selectedVoiceURI, speechRate]);

  // Main Speech play dispatcher (attempts streaming API -> falls back to browser TTS)
  const speak = useCallback(async (text: string) => {
    stopAudioPlayback();
    if (!text.trim()) {
      if (shouldListenRef.current && !mutedRef.current) {
        setStatus("listening");
      }
      return;
    }

    setStatus("speaking");

    try {
      const res = await fetch(`${API_BASE_URL}/live/stream/tts`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session_id: sessionIdRef.current,
          text,
          voice_id: selectedVoiceURI
        })
      });

      if (!res.ok) {
        throw new Error("TTS Stream Endpoint returned non-ok status code");
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onplay = () => {
        setStatus("speaking");
      };

      audio.onended = () => {
        URL.revokeObjectURL(url);
        if (statusRef.current === "speaking") {
          if (shouldListenRef.current && !mutedRef.current) {
            setStatus("listening");
          } else {
            setStatus("idle");
          }
        }
      };

      audio.onerror = () => {
        URL.revokeObjectURL(url);
        // Fallback
        speakLocalTts(text);
      };

      await audio.play();
    } catch (e) {
      // If endpoint is unconfigured (501) or network fails, fall back to native browser speechSynthesis
      speakLocalTts(text);
    }
  }, [token, selectedVoiceURI, stopAudioPlayback, speakLocalTts]);

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

    let base64Frame = null;

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
      base64Frame = await captureBase64Frame();
    }

    setStatus("thinking");

    try {
      const sid = await ensureSession();
      // Call sendLiveMessage with the updated backend structure and optional inline image
      const result = await api.sendLiveMessage(token, {
        session_id: sid,
        text: text,
        image_base64: base64Frame,
        provider: defaultProvider,
        model: defaultModel,
        language
      });

      const answer = result.answer || result.response_text || "";
      addLine("assistant", answer);
      
      if (result.should_speak !== false) {
        speak(answer);
      } else {
        if (shouldListenRef.current && !mutedRef.current) {
          setStatus("listening");
        } else {
          setStatus("idle");
        }
      }
    } catch (e: any) {
      console.error("Failed to fetch response:", e);
      setError(e.message || "Connection interrupted. Tap to retry.");
      setStatus("error");
    }
  }, [token, cameraActive, captureBase64Frame, ensureSession, addLine, speak, defaultModel, defaultProvider, language, stopAudioPlayback]);

  // Instant voice interruption handler
  const handleInterruption = useCallback(() => {
    if (statusRef.current !== "speaking") return;
    console.log("Interruption: stopping speech stream.");
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

      // Vibe Call Pro VAD Timing: 800ms silence detection for faster turns
      silenceTimerRef.current = setTimeout(() => {
        const textToSend = accumulatedTranscriptRef.current.trim() || interim.trim();
        if (textToSend) {
          accumulatedTranscriptRef.current = "";
          setInterimTranscript("");
          void triggerResponse(textToSend);
        }
      }, 800);
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

  // Retry when connection errors occur
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
    scrollRef,
    toggleMute,
    retryCall,
    triggerResponse,
    endCall,
    addLine,
  };
}
