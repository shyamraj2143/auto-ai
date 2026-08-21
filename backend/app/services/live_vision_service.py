import base64
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.groq_service import groq_service
from app.services.nvidia_vision_service import nvidia_vision_service
from app.models.live import VisionFrame


logger = logging.getLogger("auto_ai.live.vision")

VISUAL_TRIGGER_PATTERN = re.compile(
    r"(?:ye+h?\s+kya|isme\s+kya|ise\s+dekho|camera\s+me(?:in)?|"
    r"is\s+problem\s+ko\s+solve|ab\s+kya\s+karna|what(?:'s|\s+is)\s+this|"
    r"look\s+at\s+this|explain\s+this\s+screen|what\s+should\s+i\s+do\s+here|"
    r"what\s+do\s+you\s+see|screen\s+dekho)",
    re.IGNORECASE,
)


@dataclass
class VisualContext:
    frame_id: str = ""
    timestamp: datetime | None = None
    summary: str = ""
    detected_text: str = ""
    scene_objects: tuple[str, ...] = ()
    confidence: float = 0.0

    def age_seconds(self) -> float:
        if not self.timestamp:
            return float("inf")
        return max(0.0, (datetime.now(timezone.utc) - self.timestamp).total_seconds())

    def as_event(self) -> dict:
        return {
            "frame_id": self.frame_id,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "summary": self.summary,
            "detected_text": self.detected_text,
            "scene_objects": list(self.scene_objects),
            "confidence": self.confidence,
        }


class LiveVisionService:
    max_frame_bytes = 4 * 1024 * 1024

    def is_visual_question(self, text: str) -> bool:
        return bool(VISUAL_TRIGGER_PATTERN.search(text or ""))

    def analyze_frame(self, db: Session, *, session_id: str, user_id: str, image_base64: str, prompt: str = "") -> VisualContext:
        image = self._decode_frame(image_base64)
        vision_prompt = (
            "Privately inspect this live camera frame. Return a concise factual scene summary, "
            "including visible text, important objects, UI controls, and spatial clues. Never address "
            "the user and never claim certainty for unreadable details."
        )
        if prompt.strip():
            vision_prompt += f" The user's current question is: {prompt.strip()}"
        summary = self._analyze_with_fallback(image, vision_prompt).strip()
        frame = VisionFrame(session_id=session_id, user_id=user_id, image_url="", analysis_summary=summary)
        db.add(frame)
        db.commit()
        db.refresh(frame)
        return VisualContext(frame_id=frame.id, timestamp=frame.created_at.replace(tzinfo=timezone.utc), summary=summary, confidence=0.85 if summary else 0.0)

    def _analyze_with_fallback(self, image: bytes, prompt: str) -> str:
        errors: list[str] = []

        # NVIDIA is the primary multimodal analyzer for camera/image understanding.
        try:
            return nvidia_vision_service.analyze_image(image, "live-frame.jpg", prompt, mime_type="image/jpeg")
        except Exception as exc:
            errors.append(f"nvidia: {exc}")

        # Groq is the supported application fallback for live vision.
        try:
            return groq_service.analyze_image(image, "live-frame.jpg", prompt)
        except Exception as exc:
            errors.append(f"groq: {exc}")

        logger.warning("live_vision_provider_failure errors=%s", errors)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Live vision provider is unavailable.")

    def _decode_frame(self, value: str) -> bytes:
        encoded = value.split(",", 1)[1] if "," in value else value
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid camera frame.") from exc
        if not data:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Camera frame is empty.")
        if len(data) > self.max_frame_bytes:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Camera frame is too large.")
        return data


live_vision_service = LiveVisionService()
