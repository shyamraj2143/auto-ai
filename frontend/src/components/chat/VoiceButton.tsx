import { Mic, Square } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../contexts/AuthContext";

export function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const { token } = useAuth();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function startRecording() {
    setError(false);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(true);
      return;
    }
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      if (!token) return;
      setLoading(true);
      try {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const result = await api.transcribeAudio(token, blob);
        if (result.text.trim()) onTranscript(result.text.trim());
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  return (
    <button
      className={error ? "icon-button-danger" : "icon-button-dark"}
      disabled={loading}
      onClick={recording ? stopRecording : startRecording}
      title={recording ? "Stop recording" : "Record voice"}
      type="button"
    >
      {recording ? <Square size={18} /> : <Mic size={18} />}
    </button>
  );
}
