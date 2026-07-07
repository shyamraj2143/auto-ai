import { Mic } from "lucide-react";

export function VoiceButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      className="icon-button-dark"
      onClick={onOpen}
      title="Open live voice"
      type="button"
    >
      <Mic size={18} />
    </button>
  );
}
