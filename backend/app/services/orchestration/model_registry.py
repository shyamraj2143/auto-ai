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
DISPLAY_NAMES = {
    "openai/gpt-oss-120b": "GPT-OSS 120B",
    "openai/gpt-oss-20b": "GPT-OSS 20B",
    "llama-3.3-70b-versatile": "Llama 3.3 70B",
    "llama-3.1-8b-instant": "Llama 3.1 8B",
    "qwen/qwen3-32b": "Qwen 3 32B",
    "meta-llama/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
}
INCOMPATIBLE_TEXT_MODEL_MARKERS = ("whisper", "speech", "tts", "orpheus", "voxtral", "embedding", "embed-", "moderation", "guard", "rerank", "image-generation", "diffusion", "translate", "ocr")
MAX_PROVIDER_POOL = 20


def _display_name(model_id: str) -> str:
    return DISPLAY_NAMES.get(model_id, model_id.replace("/", " ").replace(".", " ").replace("-", " ").title())


def _capabilities(model_id: str) -> frozenset[str]:
    value = model_id.lower()
    if any(marker in value for marker in INCOMPATIBLE_TEXT_MODEL_MARKERS):
        return frozenset({"non_chat"})
    capabilities = {"text", "chat"}
    if any(token in value for token in ("coder", "coding", "code")):
        capabilities.add("coding")
    if any(token in value for token in ("vision", "vl", "omni", "multimodal", "inkling", "kimi-k2")):
        capabilities.add("vision")
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
            discovered = {"groq": self._discover_groq(), "nvidia": self._discover_nvidia(), "bedrock": self._discover_bedrock(), "openai": self._discover_openai_compatible("openai"), "gemini": self._discover_openai_compatible("gemini")}
            now = datetime.now(timezone.utc)
            records: dict[tuple[str, str], ModelRecord] = {}
            provider_defaults = {
                "groq": [*settings.ORCHESTRATION_GROQ_MODELS, settings.ORCHESTRATION_GROQ_CODING_MODEL],
                "nvidia": discovered["nvidia"][:MAX_PROVIDER_POOL],
                "bedrock": [*settings.ORCHESTRATION_BEDROCK_MODELS, settings.ORCHESTRATION_BEDROCK_CODING_MODEL],
                "openai": [settings.OPENAI_MODEL, *settings.OPENAI_RESEARCH_MODELS],
                "gemini": [settings.GEMINI_MODEL, *settings.GEMINI_RESEARCH_MODELS],
            }
            for provider, configured_defaults in provider_defaults.items():
                available = discovered[provider]
                if provider in {"groq", "nvidia"}:
                    configured = [*sorted(available), *configured_defaults][:MAX_PROVIDER_POOL]
                else:
                    configured = [*sorted(available), *configured_defaults] if settings.ORCHESTRATION_INCLUDE_ALL_AVAILABLE_MODELS else configured_defaults
                for index, model_id in enumerate(dict.fromkeys(configured)):
                    if not model_id:
                        continue
                    is_available = model_id in available
                    capabilities = _capabilities(model_id)
                    modes = {IntelligenceMode.INSTANT, IntelligenceMode.MEDIUM, IntelligenceMode.HIGH, IntelligenceMode.DEEP_RESEARCH} if provider in {"groq", "nvidia", "openai", "gemini"} else {IntelligenceMode.HIGH, IntelligenceMode.DEEP_RESEARCH}
                    if {"text", "chat"}.issubset(capabilities):
                        modes.add(IntelligenceMode.CODING)
                    value = model_id.lower()
                    quality = 1.0
                    if any(token in value for token in ("253b", "235b", "120b", "70b", "ultra", "pro", "m3", "glm5")):
                        quality = 1.6
                    elif any(token in value for token in ("32b", "34b", "30b", "27b", "20b")):
                        quality = 1.3
                    records[(provider, model_id)] = ModelRecord(
                        provider=provider,
                        friendly_name=_display_name(model_id),
                        actual_model_id=model_id,
                        enabled=is_available,
                        supported_modes=frozenset(modes),
                        capabilities=capabilities,
                        supports_streaming=provider in {"groq", "openai", "gemini"},
                        supports_vision="vision" in capabilities,
                        priority=index,
                        latency_weight=0.6 if any(token in value for token in ("instant", "8b", "20b", "mini", "flash")) else 1.0,
                        quality_weight=quality,
                        timeout_seconds=float(settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS),
                        required_region=settings.bedrock_region if provider == "bedrock" else None,
                        health_status="healthy" if is_available else "unavailable",
                        last_health_check=now,
                    )
            self._records = records
            self._refreshed_at = monotonic()
            logger.info("model_registry_refresh configured=%s healthy=%s groq_pool=%s nvidia_pool=%s", len(records), sum(record.enabled for record in records.values()), sum(1 for record in records.values() if record.provider == "groq"), sum(1 for record in records.values() if record.provider == "nvidia"))
            return list(records.values())

    def eligible(self, mode: IntelligenceMode, *, provider: str | None = None) -> list[ModelRecord]:
        records = self.refresh()
        allowed_providers = {provider} if provider else set(PRESET_POLICIES[mode].providers)
        return sorted((record for record in records if record.enabled and record.health_status == "healthy" and {"text", "chat"}.issubset(record.capabilities) and mode in record.supported_modes and record.provider in allowed_providers), key=lambda item: (item.priority, item.latency_weight - item.quality_weight))

    def mark_result(self, provider: str, model_id: str, *, success: bool) -> None:
        with self._lock:
            key = (provider, model_id)
            record = self._records.get(key)
            if record:
                self._records[key] = replace(record, health_status="healthy" if success else "degraded", last_health_check=datetime.now(timezone.utc))

    @staticmethod
    def _discover_groq() -> set[str]:
        try:
            models = groq_service._client().models.list()
            return {str(item.id) for item in getattr(models, "data", []) if getattr(item, "id", None)}
        except Exception as exc:
            logger.warning("model_registry_discovery provider=groq success=false error_type=%s", type(exc).__name__)
            return set()

    @staticmethod
    def _discover_nvidia() -> list[str]:
        try:
            return nvidia_text_service.list_models()[:MAX_PROVIDER_POOL]
        except Exception as exc:
            logger.warning("model_registry_discovery provider=nvidia success=false error_type=%s", type(exc).__name__)
            return []

    @staticmethod
    def _discover_bedrock() -> set[str]:
        if not (settings.bedrock_api_key or (settings.aws_access_key_id and settings.aws_secret_access_key)):
            return set()
        if settings.bedrock_endpoint_mode.lower() != "mantle":
            return {model_id for model_id in (settings.BEDROCK_MODEL, *settings.BEDROCK_RESEARCH_MODELS, *settings.ORCHESTRATION_BEDROCK_MODELS, settings.ORCHESTRATION_BEDROCK_CODING_MODEL) if model_id}
        try:
            response = httpx.get(f"{settings.bedrock_mantle_base_url}/models", headers=groq_service._bedrock_mantle_headers(), timeout=8)
            response.raise_for_status()
            body = response.json()
            return {str(item.get("id")) for item in body.get("data", []) if isinstance(item, dict) and item.get("id")}
        except Exception as exc:
            logger.warning("model_registry_discovery provider=bedrock success=false error_type=%s", type(exc).__name__)
            return set()

    @staticmethod
    def _discover_openai_compatible(provider: str) -> set[str]:
        if provider == "openai":
            key, base_url, headers, configured = settings.OPENAI_API_KEY, settings.OPENAI_BASE_URL, groq_service._openai_headers() if settings.OPENAI_API_KEY else {}, {settings.OPENAI_MODEL, *settings.OPENAI_RESEARCH_MODELS}
        else:
            key, base_url, headers, configured = settings.GEMINI_API_KEY, settings.GEMINI_BASE_URL, groq_service._gemini_headers() if settings.GEMINI_API_KEY else {}, {settings.GEMINI_MODEL, *settings.GEMINI_RESEARCH_MODELS}
        if not key:
            return set()
        try:
            response = httpx.get(f"{base_url.rstrip('/')}/models", headers=headers, timeout=8)
            response.raise_for_status()
            body = response.json()
            discovered = {str(item.get("id")) for item in body.get("data", []) if isinstance(item, dict) and item.get("id")}
            return discovered or {item for item in configured if item}
        except Exception as exc:
            logger.warning("model_registry_discovery provider=%s success=false error_type=%s", provider, type(exc).__name__)
            return {item for item in configured if item}


model_registry = ModelRegistry()
