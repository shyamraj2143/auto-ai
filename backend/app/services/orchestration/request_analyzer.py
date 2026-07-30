import re

from app.services.orchestration.schemas import IntelligenceMode, RequestAnalysis


class RequestAnalyzer:
    @staticmethod
    def analyze(message: str, mode: IntelligenceMode) -> RequestAnalysis:
        lowered = message.lower()
        code = bool(re.search(r"```|\b(code|bug|api|function|class|typescript|python|sql)\b", lowered))
        math = bool(re.search(r"\b(calculate|equation|proof|integral|probability)\b|[=∑√]", lowered))
        recent = bool(re.search(r"\b(today|latest|current|recent|news|202[5-9])\b", lowered))
        long_request = len(message) > 1200 or message.count("\n") > 12
        complexity = "high" if long_request or code or math or mode in {IntelligenceMode.HIGH, IntelligenceMode.DEEP_RESEARCH} else "medium"
        language = "Hindi" if re.search(r"[\u0900-\u097f]|\b(kya|kaise|hai|hindi)\b", lowered) else "user's language"
        return RequestAnalysis(
            intent="code" if code else "mathematics" if math else "research" if recent else "general",
            language=language,
            complexity=complexity,
            expertise="technical" if code or math else "general",
            response_format="structured" if long_request else "direct",
            needs_current_information=recent or mode == IntelligenceMode.DEEP_RESEARCH,
            safety_review=bool(re.search(r"\b(medical|legal|financial|weapon|self-harm)\b", lowered)),
            token_budget=1600 if complexity == "high" else 900,
            latency_budget_seconds=90 if mode != IntelligenceMode.INSTANT else 35,
        )


request_analyzer = RequestAnalyzer()
