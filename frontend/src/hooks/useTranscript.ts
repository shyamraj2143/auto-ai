import { useState, useCallback, useRef, useEffect } from "react";

export interface TranscriptLine {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  language?: string;
}

export function useTranscript() {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const addLine = useCallback((role: TranscriptLine["role"], text: string, language?: string) => {
    if (!text.trim()) return;
    setLines((current) => [
      ...current,
      {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        role,
        text: text.trim(),
        language,
      },
    ]);
  }, []);

  const clearTranscripts = useCallback(() => {
    setLines([]);
  }, []);

  // Auto scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  return {
    lines,
    addLine,
    clearTranscripts,
    scrollRef,
  };
}
