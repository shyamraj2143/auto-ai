import type { AlarmLanguage, UserAlarm } from "./types";
import type { AwakeFailureCode } from "./awakeEvaluation";

function taskTitle(alarm: Pick<UserAlarm, "title">) {
  const clean = alarm.title.replace(/\s+/g, " ").trim().slice(0, 100);
  return clean || "अपने जरूरी काम";
}

export function awakeSuccessSpeech(alarm: Pick<UserAlarm, "title" | "language">) {
  const task = taskTitle(alarm);
  if (alarm.language === "en-IN") {
    return `Thank you, you are awake now. Please get ready for ${task}. If you need help with anything, you can ask in AutoAI Chat.`;
  }
  if (alarm.language === "hi-IN") {
    return `धन्यवाद, अब आप जाग चुके हैं। जल्दी से ${task} के लिए तैयार हो जाइए। किसी भी चीज़ में मदद चाहिए तो AutoAI के AI Chat में जाकर पूछ सकते हैं।`;
  }
  return `थैंक यू, अब आप जाग चुके हैं। अब जल्दी से ${task} के लिए तैयार हो जाइए। किसी भी चीज़ में मदद चाहिए तो AutoAI के AI Chat में जाकर पूछ सकते हैं।`;
}

export function awakeFailureSpeech(code: AwakeFailureCode, language: AlarmLanguage) {
  if (language === "en-IN") {
    if (code === "eyes_closed") return "Your eyes are closed, so you still look asleep. The alarm will not stop. Open both eyes, look at the camera and capture again.";
    if (code === "no_face") return "Your face is not visible. The alarm will not stop. Look directly at the front camera and capture again.";
    if (code === "multiple_faces") return "Only your face should be in the camera. The alarm will not stop. Please capture again.";
    if (code === "image_quality") return "The photo is too dark or unclear. The alarm will not stop. Use better light and capture again.";
    return "You do not look fully awake yet. The alarm will not stop. Hold your head straight, open both eyes and capture again.";
  }
  if (language === "hi-IN") {
    if (code === "eyes_closed") return "आपकी आँखें बंद हैं, इसलिए लग रहा है कि आप अभी सोए हुए हैं। अलार्म बंद नहीं होगा। दोनों आँखें खोलकर कैमरे की ओर देखें और फिर से फोटो लें।";
    if (code === "no_face") return "आपका चेहरा दिखाई नहीं दे रहा है। अलार्म बंद नहीं होगा। सामने वाले कैमरे की ओर देखकर फिर से फोटो लें।";
    if (code === "multiple_faces") return "कैमरे में केवल आपका चेहरा होना चाहिए। अलार्म बंद नहीं होगा। कृपया फिर से फोटो लें।";
    if (code === "image_quality") return "फोटो अंधेरी या साफ नहीं है। अलार्म बंद नहीं होगा। रोशनी ठीक करके फिर से फोटो लें।";
    return "आप अभी पूरी तरह जागे हुए नहीं लग रहे हैं। अलार्म बंद नहीं होगा। सिर सीधा रखें, दोनों आँखें खोलें और फिर से फोटो लें।";
  }
  if (code === "eyes_closed") return "आपकी आँखें बंद हैं, लगता है आप अभी सोए हुए हैं। अलार्म बंद नहीं होगा। दोनों आँखें खोलकर कैमरे की तरफ देखें और दोबारा फोटो लें।";
  if (code === "no_face") return "आपका फेस कैमरे में नहीं दिख रहा है। अलार्म बंद नहीं होगा। फ्रंट कैमरे की तरफ देखकर दोबारा फोटो लें।";
  if (code === "multiple_faces") return "कैमरे में सिर्फ आपका फेस होना चाहिए। अलार्म बंद नहीं होगा। प्लीज दोबारा फोटो लें।";
  if (code === "image_quality") return "फोटो डार्क या क्लियर नहीं है। अलार्म बंद नहीं होगा। लाइट ठीक करके दोबारा फोटो लें।";
  return "आप अभी पूरी तरह जागे हुए नहीं लग रहे हैं। अलार्म बंद नहीं होगा। सिर सीधा रखें, दोनों आँखें खोलें और दोबारा फोटो लें।";
}
