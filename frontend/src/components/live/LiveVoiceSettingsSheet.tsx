import { Volume2, X } from "lucide-react";
import { AppSelect } from "../common/AppSelect";

type VoiceOption = { voiceURI: string; name: string };

type Props = {
  open: boolean;
  language: string;
  voiceURI: string;
  rate: number;
  volume: number;
  voices: VoiceOption[];
  onLanguageChange: (value: string) => void;
  onVoiceChange: (value: string) => void;
  onRateChange: (value: number) => void;
  onVolumeChange: (value: number) => void;
  onClose: () => void;
};

export function LiveVoiceSettingsSheet(props: Props) {
  if (!props.open) return null;
  return (
    <>
      <button className="live-settings-dismiss" type="button" aria-label="Close voice settings" onClick={props.onClose} />
      <section className="live-voice-settings" role="dialog" aria-modal="false" aria-label="Voice settings">
        <header>
          <strong>Voice settings</strong>
          <button type="button" onClick={props.onClose} aria-label="Close voice settings"><X size={18} /></button>
        </header>
        <label>
          <span>Language</span>
          <AppSelect label="Language" value={props.language} onChange={props.onLanguageChange} options={[{value:"hinglish",label:"Hinglish"},{value:"hindi",label:"Hindi"},{value:"english",label:"English"}]} />
        </label>
        <label>
          <span>Voice</span>
          <AppSelect label="Voice" value={props.voiceURI} onChange={props.onVoiceChange} options={props.voices.length ? props.voices.map((voice) => ({ value: voice.voiceURI, label: voice.name })) : [{ value: "", label: "System voice" }]} />
        </label>
        <label>
          <span>Speed <output>{props.rate.toFixed(1)}×</output></span>
          <input type="range" min="0.7" max="1.4" step="0.1" value={props.rate} onChange={(event) => props.onRateChange(Number(event.target.value))} />
        </label>
        <label>
          <span><Volume2 size={16} /> Volume <output>{Math.round(props.volume * 100)}%</output></span>
          <input type="range" min="0" max="1" step="0.05" value={props.volume} onChange={(event) => props.onVolumeChange(Number(event.target.value))} />
        </label>
      </section>
    </>
  );
}
