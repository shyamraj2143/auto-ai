from __future__ import annotations

import logging
import threading
from dataclasses import replace
from datetime import datetime, timezone
from time import monotonic

import httpx

from app.core.config import settings
from app.services.groq_service import groq_service
from app.services.nvidia_text_service import nvidia_text_service
from app.services.orchestration.schemas import IntelligenceMode, ModelRecord
from app.services.orchestration.preset_policy import PRESET_POLICIES

logger = logging.getLogger("auto_ai.model_registry")
DISPLAY_NAMES = {"openai/gpt-oss-120b": "GPT-OSS 120B", "openai/gpt-oss-20b": "GPT-OSS 20B", "llama-3.3-70b-versatile": "Llama 3.3 70B", "llama-3.1-8b-instant": "Llama 3.1 8B", "qwen/qwen3-32b": "Qwen 3 32B", "meta-llama/llama-4-scout-17b-16e-instruct": "Llama 4 Scout"}
INCOMPATIBLE_TEXT_MODEL_MARKERS = ("whisper", "speech", "tts", "orpheus", "voxtral", "embedding", "embed-", "moderation", "guard", "rerank", "image-generation", "diffusion", "translate", "ocr")
MAX_PROVIDER_POOL = 20


def _display_name(model_id: str) -> str:
    return DISPLAY_NAMES.get(model_id, model_id.replace("/", " ").replace(".", " ").replace("-", " ").title())


def _capabilities(model_id: str) -> frozenset[str]:
    value = model_id.lower()
    if any(marker in value for marker in INCOMPATIBLE_TEXT_MODEL_MARKERS):
        return frozenset({"non_chat"})
    capabilities = {"text", "chat"}
    if any(token in value for token in ("coder", "coding", "code")): capabilities.add("coding")
    if any(token in value for token in ("vision", "vl", "omni", "multimodal", "inkling", "kimi-k2")): capabilities.add("vision")
    return frozenset(capabilities)


class ModelRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._records: dict[tuple[str, str], ModelRecord] = {}
        self._refreshed_at = 0.0

    def refresh(self, *, force: bool = False) -> list[ModelRecord]:
        with self._lock:
            if not force and self._records and monotonic() - self._refreshed_at < settings.ORCHESTRATION_HEALTH_TTL_SECONDS:
                return list(self._records.values())
            discovered = {"groq": self._discover_groq(), "nvidia": self._discover_nvidia(), "openai": self._discover_openai_compatible("openai")}
            now = datetime.now(timezone.utc)
            provider_defaults = {
                "groq": [*settings.ORCHESTRATION_GROQ_MODELS, settings.ORCHESTRATION_GROQ_CODING_MODEL],
                "nvidia": discovered["nvidia"][:MAX_PROVIDER_POOL],
                "openai": [settings.OPENAI_MODEL, *settings.OPENAI_RESEARCH_MODELS],
            }
            records: dict[tuple[str, str], ModelRecord] = {}
            for provider, configured_defaults in provider_defaults.items():
                available = discovered[provider]
                configured = ([*sorted(available), *configured_defaults][:MAX_PROVIDER_POOL] if provider in {"groq", "nvidia"} else ([*sorted(available), *configured_defaults] if settings.ORCHESTRATION_INCLUDE_ALL_AVAILABLE_MODELS else configured_defaults))
                for index, model_id in enumerate(dict.fromkeys(configured)):
                    if not model_id: continue
                    is_available = model_id in available
                    capabilities = _capabilities(model_id)
                    modes = {IntelligenceMode.INSTANT, IntelligenceMode.MEDIUM, IntelligenceMode.HIGH, IntelligenceMode.DEEP_RESEARCH, IntelligenceMode.CODING}
                    value = model_id.lower()
                    quality = 1.6 if any(token in value for token in ("253b", "235b", "120b", "70b", "ultra", "pro", "m3", "glm5")) else 1.3 if any(token in value for token in ("32b", "34b", "30b", "27b", "20b")) else 1.0
                    records[(provider, model_id)] = ModelRecord(provider=provider, friendly_name=_display_name(model_id), actual_model_id=model_id, enabled=is_available, supported_modes=frozenset(modes), capabilities=capabilities, supports_streaming=provider in {"groq", "openai", "nvidia"}, supports_vision="vision" in capabilities, priority=index, latency_weight=0.6 if any(token in value for token in ("instant", "8b", "20b", "mini", "flash")) else 1.0, quality_weight=quality, timeout_seconds=float(settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS), required_region=None, health_status="healthy" if is_available else "unavailable", last_health_check=now)
            self._records = records
            self._refreshed_at = monotonic()
            return list(records.values())

    def eligible(self, mode: IntelligenceMode, *, provider: str | None = None) -> list[ModelRecord]:
        records = self.refresh()
        allowed = {provider} if provider else set(PRESET_POLICIES[mode].providers)
        return sorted((r for r in records if r.enabled and r.health_status == "healthy" and {"text", "chat"}.issubset(r.capabilities) and mode in r.supported_modes and r.provider in allowed), key=lambda r: (r.priority, r.latency_weight - r.quality_weight))

    def mark_result(self, provider: str, model_id: str, *, success: bool) -> None:
        with self._lock:
            record = self._records.get((provider, model_id))
            if record:
                self._records[(provider, model_id)] = replace(record, health_status="healthy" if success else "degraded", last_health_check=datetime.now(timezone.utc))

    @staticmethod
    def _discover_groq() -> set[str]:
        configured = {m for m in (*settings.ORCHESTRATION_GROQ_MODELS, settings.GROQ_MODEL, settings.GROQ_SEARCH_MODEL, settings.GROQ_VISION_MODEL) if m}
        api_key = settings.groq_api_key
        if not api_key: return set()
        try:
            response = httpx.get("https://api.groq.com/openai/v1/models", headers={"Authorization": f"Bearer {api_key}"}, timeout=8)
            response.raise_for_status()
            discovered = {str(item.get("id")) for item in response.json().get("data", []) if isinstance(item, dict) and item.get("id")}
            return discovered or configured
        except Exception as exc:
            logger.warning("model_registry_discovery provider=groq error_type=%s", type(exc).__name__)
            return configured

    @staticmethod
    def _discover_nvidia() -> list[str]:
        try: return nvidia_text_service.list_models()[:MAX_PROVIDER_POOL]
        except Exception as exc:
            logger.warning("model_registry_discovery provider=nvidia error_type=%s", type(exc).__name__)
            return []

    @staticmethod
    def _discover_openai_compatible(provider: str) -> set[str]:
        if provider != "openai":
            return set()
        key, base_url, headers, configured = settings.OPENAI_API_KEY, settings.OPENAI_BASE_URL, groq_service._openai_headers() if settings.OPENAI_API_KEY else {}, {settings.OPENAI_MODEL, *settings.OPENAI_RESEARCH_MODELS}
        if not key: return set()
        try:
            response = httpx.get(f"{base_url.rstrip('/')}/models", headers=headers, timeout=8)
            response.raise_for_status()
            discovered = {str(item.get("id")) for item in response.json().get("data", []) if isinstance(item, dict) and item.get("id")}
            return discovered or {m for m in configured if m}
        except Exception as exc:
            logger.warning("model_registry_discovery provider=%s error_type=%s", provider, type(exc).__name__)
            return {m for m in configured if m}


model_registry = ModelRegistry()
