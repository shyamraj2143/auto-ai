package com.autoai.app;

import java.util.Locale;

final class AlarmAssistantSpeech {
    private AlarmAssistantSpeech() {}

    static String localFailure(AlarmPayload alarm, AlarmAwakeVerifier.LocalResult result) {
        String reason = result == null || result.reason == null ? "" : result.reason.toLowerCase(Locale.ROOT);
        boolean eyesClosed = result != null && result.faceRatio > 0d
            && (result.leftEyeOpen < .52d || result.rightEyeOpen < .52d || reason.contains("eye"));
        String kind = eyesClosed ? "eyes" : reason.contains("no face") ? "no_face"
            : reason.contains("only your face") ? "multiple"
            : reason.contains("light") || reason.contains("blur") || reason.contains("photo") ? "quality" : "pose";
        return failure(alarm, kind);
    }

    static String onlineFailure(AlarmPayload alarm) {
        return failure(alarm, "eyes");
    }

    private static String failure(AlarmPayload alarm, String kind) {
        String language = alarm == null ? "hinglish-IN" : alarm.language;
        if ("en-IN".equals(language)) {
            if ("eyes".equals(kind)) return "Your eyes are closed, so you still look asleep. The alarm will not stop. Open both eyes, look at the camera and capture again.";
            if ("no_face".equals(kind)) return "Your face is not visible. The alarm will not stop. Look directly at the front camera and capture again.";
            if ("multiple".equals(kind)) return "Only your face should be in the camera. The alarm will not stop. Please capture again.";
            if ("quality".equals(kind)) return "The photo is too dark or unclear. The alarm will not stop. Use better light and capture again.";
            return "You do not look fully awake yet. The alarm will not stop. Hold your head straight, open both eyes and capture again.";
        }
        if ("hi-IN".equals(language)) {
            if ("eyes".equals(kind)) return "आपकी आँखें बंद हैं, इसलिए लग रहा है कि आप अभी सोए हुए हैं। अलार्म बंद नहीं होगा। दोनों आँखें खोलकर कैमरे की ओर देखें और फिर से फोटो लें।";
            if ("no_face".equals(kind)) return "आपका चेहरा दिखाई नहीं दे रहा है। अलार्म बंद नहीं होगा। सामने वाले कैमरे की ओर देखकर फिर से फोटो लें।";
            if ("multiple".equals(kind)) return "कैमरे में केवल आपका चेहरा होना चाहिए। अलार्म बंद नहीं होगा। कृपया फिर से फोटो लें।";
            if ("quality".equals(kind)) return "फोटो अंधेरी या साफ नहीं है। अलार्म बंद नहीं होगा। रोशनी ठीक करके फिर से फोटो लें।";
            return "आप अभी पूरी तरह जागे हुए नहीं लग रहे हैं। अलार्म बंद नहीं होगा। सिर सीधा रखें, दोनों आँखें खोलें और फिर से फोटो लें।";
        }
        if ("eyes".equals(kind)) return "आपकी आँखें बंद हैं, लगता है आप अभी सोए हुए हैं। अलार्म बंद नहीं होगा। दोनों आँखें खोलकर कैमरे की तरफ देखें और दोबारा फोटो लें।";
        if ("no_face".equals(kind)) return "आपका फेस कैमरे में नहीं दिख रहा है। अलार्म बंद नहीं होगा। फ्रंट कैमरे की तरफ देखकर दोबारा फोटो लें।";
        if ("multiple".equals(kind)) return "कैमरे में सिर्फ आपका फेस होना चाहिए। अलार्म बंद नहीं होगा। प्लीज दोबारा फोटो लें।";
        if ("quality".equals(kind)) return "फोटो डार्क या क्लियर नहीं है। अलार्म बंद नहीं होगा। लाइट ठीक करके दोबारा फोटो लें।";
        return "आप अभी पूरी तरह जागे हुए नहीं लग रहे हैं। अलार्म बंद नहीं होगा। सिर सीधा रखें, दोनों आँखें खोलें और दोबारा फोटो लें।";
    }

    static String success(AlarmPayload alarm) {
        String language = alarm == null ? "hinglish-IN" : alarm.language;
        String task = cleanTask(alarm == null ? "your important task" : alarm.title);
        if ("en-IN".equals(language)) {
            return "Thank you, you are awake now. Please get ready for " + task
                + ". If you need help with anything, you can ask in AutoAI Chat.";
        }
        if ("hi-IN".equals(language)) {
            return "धन्यवाद, अब आप जाग चुके हैं। जल्दी से " + task
                + " के लिए तैयार हो जाइए। किसी भी चीज़ में मदद चाहिए तो AutoAI के AI Chat में जाकर पूछ सकते हैं।";
        }
        return "थैंक यू, अब आप जाग चुके हैं। अब जल्दी से " + task
            + " के लिए तैयार हो जाइए। किसी भी चीज़ में मदद चाहिए तो AutoAI के AI Chat में जाकर पूछ सकते हैं।";
    }

    private static String cleanTask(String value) {
        String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (clean.isEmpty()) clean = "अपने जरूरी काम";
        return clean.length() > 100 ? clean.substring(0, 100) : clean;
    }
}
