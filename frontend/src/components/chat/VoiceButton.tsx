import { Mic } from "lucide-react";

export function VoiceButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className="icon-button-dark mic-breathing"
      onClick={onOpen}
      title="Open live voice"
      aria-label="Start AI voice input"
      type="button"
    >
      <Mic size={18} />
    </button>
  );
}
