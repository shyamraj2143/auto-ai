from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

import httpx
from fastapi import HTTPException, status

logger = logging.getLogger("auto_ai.nvidia_text")

# Models which cannot produce a final chat response through /chat/completions.
NON_CHAT_MARKERS = (
    "embed", "rerank", "guard", "safety", "moderation", "moderator", "clip",
    "tts", "speech", "asr", "whisper", "page-elements", "parse", "segmentation",
    "biomedclip", "esm2", "protein", "image-generation", "diffusion", "video-super-resolution",
    "translate", "ocr",
)
MAX_FREE_POOL_MODELS = 20


class NvidiaTextService:
    _models_cache: list[str] = []
    _models_cache_at = 0.0
    _models_lock = threading.RLock()
    _models_cache_ttl = 300.0

    def _key(self) -> str:
        key = os.getenv("NVIDIA_API_KEY", "").strip()
        if not key:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="NVIDIA_API_KEY is not configured.")
        return key

    def _base_url(self) -> str:
        return os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1").rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._key()}", "Accept": "application/json", "Content-Type": "application/json"}

    @staticmethod
    def _is_candidate(model_id: str) -> bool:
        value = model_id.lower()
        return not any(marker in value for marker in NON_CHAT_MARKERS)

    def list_models(self, *, force_refresh: bool = False) -> list[str]:
        """Return at most 20 response-capable NVIDIA models from the accessible catalog."""
        now = time.monotonic()
        with self._models_lock:
            if not force_refresh and self._models_cache and now - self._models_cache_at < self._models_cache_ttl:
                return list(self._models_cache)
        try:
            response = httpx.get(f"{self._base_url()}/models", headers=self._headers(), timeout=8)
            response.raise_for_status()
            body = response.json()
            ids = [str(item.get("id")) for item in body.get("data", []) if isinstance(item, dict) and item.get("id")]
            candidates = list(dict.fromkeys(model_id for model_id in ids if self._is_candidate(model_id)))
            # Keep only the first 20 accessible chat-capable models. Selection inside
            # this pool is capability-aware and happens per request in task_planner.
            candidates = candidates[:MAX_FREE_POOL_MODELS]
            with self._models_lock:
                self._models_cache = candidates
                self._models_cache_at = time.monotonic()
            return list(candidates)
        except httpx.HTTPError as exc:
            logger.warning("nvidia_model_discovery_failed error=%s", type(exc).__name__)
            with self._models_lock:
                return list(self._models_cache)
        except (ValueError, TypeError, AttributeError) as exc:
            logger.warning("nvidia_model_discovery_invalid_response error=%s", type(exc).__name__)
            with self._models_lock:
                return list(self._models_cache)

    @staticmethod
    def _normalise_content(content: Any) -> Any:
        return content if isinstance(content, list) else str(content or "")

    def complete(self, messages: list[dict[str, Any]], *, model: str, max_tokens: int = 2048, temperature: float = 0.2, request_timeout: float = 60) -> tuple[str, dict[str, int], str]:
        payload = {
            "model": model,
            "messages": [{"role": str(message.get("role", "user")), "content": self._normalise_content(message.get("content"))} for message in messages],
            "temperature": temperature,
            "top_p": 0.9,
            "max_tokens": max_tokens,
            "stream": False,
        }
        try:
            response = httpx.post(f"{self._base_url()}/chat/completions", headers=self._headers(), json=payload, timeout=request_timeout)
        except httpx.HTTPError as exc:
            raise RuntimeError(f"NVIDIA network failure: {type(exc).__name__}") from exc
        if response.status_code in {401, 403}:
            raise RuntimeError("NVIDIA authentication/permission failure")
        if response.status_code == 429:
            raise RuntimeError("NVIDIA rate limit reached")
        if response.status_code >= 400:
            detail = response.text[:600]
            try:
                body = response.json()
                error = body.get("error", {}) if isinstance(body, dict) else {}
                detail = str(body.get("detail") or body.get("message") or (error.get("message") if isinstance(error, dict) else None) or detail)
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(f"NVIDIA HTTP {response.status_code}: {detail}")
        try:
            body = response.json()
            message = body["choices"][0]["message"]
            content = message.get("content", "") if isinstance(message, dict) else ""
            if isinstance(content, list):
                content = "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content)
            result = str(content).strip()
            if not result:
                raise ValueError("empty content")
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("NVIDIA returned an invalid/empty completion") from exc
        usage_raw = body.get("usage", {}) if isinstance(body, dict) else {}
        usage = {"prompt_tokens": int(usage_raw.get("prompt_tokens", 0) or 0), "completion_tokens": int(usage_raw.get("completion_tokens", 0) or 0), "total_tokens": int(usage_raw.get("total_tokens", 0) or 0)}
        return result, usage, model


nvidia_text_service = NvidiaTextService()
