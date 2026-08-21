from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.groq_service import groq_service


@dataclass(frozen=True)
class AwakeDecision:
    awake: bool
    confidence: float
    reason: str
    model: str


class AlarmAwakeService:
    def verify(self, *, image: bytes, filename: str) -> AwakeDecision:
        mime = self.mime_type(filename, image)
        encoded = base64.b64encode(image).decode("ascii")
        prompt = (
            "Evaluate only whether this live alarm-dismissal selfie shows one real, clearly visible face "
            "with both eyes open, the head upright, and alert wakefulness cues. Do not identify the person, "
            "infer identity, age, gender, ethnicity, health, emotion, or any other sensitive trait. "
            "Reject if there is no face, more than one face, closed/unclear eyes, severe blur/darkness, a screen "
            "or printed-photo replay, or uncertainty. Return JSON only with exactly these keys: "
            '{"awake":true|false,"confidence":0.0,"reason":"short user-facing reason"}. '
            "Use a conservative threshold: when uncertain, awake must be false."
        )
        content, _, model = groq_service.complete(
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:{mime};base64,{encoded}"},
                        },
                    ],
                }
            ],
            provider="groq",
            model=settings.ALARM_GROQ_VISION_MODEL,
            temperature=0,
            max_tokens=140,
            request_timeout=8.0,
        )
        payload = self.parse_json(content)
        awake = payload.get("awake") is True
        try:
            confidence = float(payload.get("confidence", 0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        reason = re.sub(r"\s+", " ", str(payload.get("reason") or "Please capture again.")).strip()[:220]
        if not reason:
            reason = "Awake verified." if awake else "Please capture again with both eyes open."
        return AwakeDecision(awake=awake, confidence=confidence, reason=reason, model=model or settings.ALARM_GROQ_VISION_MODEL)

    @staticmethod
    def parse_json(content: str) -> dict:
        text = str(content or "").strip()
        fenced = re.search(r"\{[\s\S]*\}", text)
        if fenced:
            text = fenced.group(0)
        try:
            value = json.loads(text)
        except (TypeError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Groq awake verification returned an invalid result.",
            ) from exc
        if not isinstance(value, dict) or not isinstance(value.get("awake"), bool):
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Groq awake verification returned an incomplete result.",
            )
        return value

    @staticmethod
    def mime_type(filename: str, image: bytes) -> str:
        name = (filename or "").lower()
        if image.startswith(b"\xff\xd8\xff") and name.endswith((".jpg", ".jpeg")):
            return "image/jpeg"
        if image.startswith(b"\x89PNG\r\n\x1a\n") and name.endswith(".png"):
            return "image/png"
        if len(image) >= 12 and image[:4] == b"RIFF" and image[8:12] == b"WEBP" and name.endswith(".webp"):
            return "image/webp"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Capture a valid JPG, PNG, or WEBP face photo.",
        )


alarm_awake_service = AlarmAwakeService()
