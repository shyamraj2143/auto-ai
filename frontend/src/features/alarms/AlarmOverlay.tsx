import { AlarmClock, BellRing, MoonStar, X } from "lucide-react";
import { useEffect } from "react";
import { alarmNative, speakInBrowser } from "./alarmNative";
import { formatAlarmDate } from "./alarmTime";
import { useAlarms } from "./AlarmContext";

function startAlarmTone() {
  if (typeof window === "undefined") return () => undefined;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return () => undefined;
  let context: AudioContext | null = null;
  let interval = 0;
  const pulse = () => {
    try {
      context ??= new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.58);
    } catch {
      // The visual alarm remains available when a browser blocks background audio.
    }
  };
  pulse();
  interval = window.setInterval(pulse, 1_300);
  return () => {
    window.clearInterval(interval);
    void context?.close();
  };
}

export function AlarmOverlay() {
  const { activeAlarm, dismissAlarm, snoozeAlarm } = useAlarms();

  useEffect(() => {
    if (!activeAlarm || alarmNative.isAndroid()) return;
    const stopTone = startAlarmTone();
    const speechTimer = window.setTimeout(() => speakInBrowser(activeAlarm.assistant_message, activeAlarm.language, activeAlarm.voice_style), 900);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(activeAlarm.title, { body: activeAlarm.assistant_message, tag: `autoai-alarm-${activeAlarm.id}`, requireInteraction: true });
    }
    return () => {
      stopTone();
      window.clearTimeout(speechTimer);
      window.speechSynthesis?.cancel();
    };
  }, [activeAlarm]);

  if (!activeAlarm || alarmNative.isAndroid()) return null;
  return (
    <div className="alarm-overlay" role="dialog" aria-modal="true" aria-labelledby="active-alarm-title">
      <section className="alarm-overlay-card">
        <span className="alarm-overlay-orbit" aria-hidden="true"><BellRing /></span>
        <p><AlarmClock size={16} /> AutoAI Personal Assistant</p>
        <h2 id="active-alarm-title">{activeAlarm.title}</h2>
        <time>{formatAlarmDate(activeAlarm.scheduled_at)}</time>
        <blockquote>{activeAlarm.assistant_message}</blockquote>
        <div>
          <button type="button" className="alarm-snooze-button" onClick={() => void snoozeAlarm(activeAlarm.id, 10)}><MoonStar /> Snooze 10 min</button>
          <button type="button" className="alarm-dismiss-button" onClick={() => void dismissAlarm(activeAlarm.id)}><X /> Dismiss</button>
        </div>
      </section>
    </div>
  );
}
