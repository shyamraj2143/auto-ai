import base64
import logging
import os
from typing import Any

import httpx
from fastapi import HTTPException, status

logger = logging.getLogger("auto_ai.nvidia_vision")


class NvidiaVisionService:
    """NVIDIA NIM multimodal client for image understanding, OCR and document intelligence."""

    def _value(self, name: str, default: str) -> str:
        return os.getenv(name, default).strip()

    def _headers(self) -> dict[str, str]:
        api_key = os.getenv("NVIDIA_API_KEY")
        if not api_key:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="NVIDIA_API_KEY is not configured.")
        return {"Authorization": f"Bearer {api_key}", "Accept": "application/json", "Content-Type": "application/json"}

    @staticmethod
    def _mime(filename: str, mime_type: str | None = None) -> str:
        allowed = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
        if mime_type in allowed:
            return "image/jpeg" if mime_type == "image/jpg" else mime_type
        suffix = filename.lower().rsplit(".", 1)[-1] if "." in filename else "jpg"
        return {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}.get(suffix, "image/jpeg")

    def analyze_image(self, image: bytes, filename: str, prompt: str, *, mime_type: str | None = None, max_tokens: int | None = None, timeout: float | None = None) -> str:
        if not image:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Image is empty.")
        encoded = base64.b64encode(image).decode("ascii")
        mime = self._mime(filename, mime_type)
        payload: dict[str, Any] = {
            "model": self._value("NVIDIA_VISION_MODEL", "nvidia/llama-3.1-nemotron-nano-vl-8b-v1"),
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{encoded}"}},
                {"type": "text", "text": prompt},
            ]}],
            "temperature": float(os.getenv("NVIDIA_VISION_TEMPERATURE", "0.2")),
            "top_p": float(os.getenv("NVIDIA_VISION_TOP_P", "0.9")),
            "max_tokens": max_tokens or int(os.getenv("NVIDIA_VISION_MAX_TOKENS", "2048")),
            "stream": False,
        }
        base_url = self._value("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
        try:
            response = httpx.post(f"{base_url.rstrip('/')}/chat/completions", headers=self._headers(), json=payload, timeout=timeout or float(os.getenv("NVIDIA_REQUEST_TIMEOUT_SECONDS", "45")))
        except httpx.HTTPError as exc:
            logger.exception("NVIDIA vision network failure")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA vision service is unreachable.") from exc
        if response.status_code in {401, 403}:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA API key was rejected.")
        if response.status_code == 429:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="NVIDIA vision rate limit reached.")
        if response.status_code >= 400:
            logger.warning("NVIDIA vision request failed status=%s body=%s", response.status_code, response.text[:1000])
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA vision analysis failed.")
        try:
            data = response.json()
            content = data["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA returned an invalid vision response.") from exc
        if isinstance(content, list):
            content = "".join(item.get("text", "") if isinstance(item, dict) else str(item) for item in content)
        result = str(content or "").strip()
        if not result:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="NVIDIA returned an empty vision response.")
        return result


nvidia_vision_service = NvidiaVisionService()
