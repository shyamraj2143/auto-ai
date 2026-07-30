from __future__ import annotations

import logging
import threading
from dataclasses import replace
from datetime import datetime, timezone
from time import monotonic

import httpx

from app.core.config import settings
from app.services.groq_service import groq_service
from app.services.orchestration.schemas import IntelligenceMode, ModelRecord


logger = logging.getLogger("auto_ai.model_registry")
DISPLAY_NAMES = {
    "openai/gpt-oss-120b": "GPT-OSS 120B",
    "openai/gpt-oss-20b": "GPT-OSS 20B",
    "llama-3.3-70b-versatile": "Llama 3.3 70B",
    "llama-3.1-8b-instant": "Llama 3.1 8B",
    "qwen/qwen3-32b": "Qwen 3 32B",
    "meta-llama/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
    "amazon.nova-pro-v1:0": "Amazon Nova Pro",
    "amazon.nova-lite-v1:0": "Amazon Nova Lite",
    "anthropic.claude-3-haiku-20240307-v1:0": "Claude 3 Haiku",
}


def _display_name(model_id: str) -> str:
    return DISPLAY_NAMES.get(model_id, model_id.replace("/", " ").replace(".", " ").replace("-", " ").title())


class ModelRegistry:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._records: dict[tuple[str, str], ModelRecord] = {}
        self._refreshed_at = 0.0

    def refresh(self, *, force: bool = False) -> list[ModelRecord]:
        with self._lock:
            if not force and self._records and monotonic() - self._refreshed_at < settings.ORCHESTRATION_HEALTH_TTL_SECONDS:
                return list(self._records.values())
            discovered = {
                "groq": self._discover_groq(),
                "bedrock": self._discover_bedrock(),
            }
            now = datetime.now(timezone.utc)
            records: dict[tuple[str, str], ModelRecord] = {}
            for provider, configured in (
                ("groq", settings.ORCHESTRATION_GROQ_MODELS),
                ("bedrock", settings.ORCHESTRATION_BEDROCK_MODELS),
            ):
                available = discovered[provider]
                for index, model_id in enumerate(dict.fromkeys(configured)):
                    if not model_id:
                        continue
                    is_available = model_id in available
                    modes = (
                        frozenset(IntelligenceMode)
                        if provider == "groq"
                        else frozenset({IntelligenceMode.HIGH, IntelligenceMode.DEEP_RESEARCH})
                    )
                    records[(provider, model_id)] = ModelRecord(
                        provider=provider,
                        friendly_name=_display_name(model_id),
                        actual_model_id=model_id,
                        enabled=is_available,
                        supported_modes=modes,
                        supports_streaming=provider == "groq",
                        supports_vision="vision" in model_id or "scout" in model_id,
                        priority=index,
                        latency_weight=0.6 if "instant" in model_id or "20b" in model_id or "lite" in model_id else 1.0,
                        quality_weight=1.4 if "120b" in model_id or "70b" in model_id or "pro" in model_id else 1.0,
                        timeout_seconds=float(settings.DEEP_RESEARCH_PER_MODEL_TIMEOUT_SECONDS),
                        required_region=settings.bedrock_region if provider == "bedrock" else None,
                        health_status="healthy" if is_available else "unavailable",
                        last_health_check=now,
                    )
            self._records = records
            self._refreshed_at = monotonic()
            logger.info(
                "model_registry_refresh configured=%s healthy=%s",
                len(records),
                sum(record.enabled for record in records.values()),
            )
            return list(records.values())

    def eligible(self, mode: IntelligenceMode, *, provider: str | None = None) -> list[ModelRecord]:
        records = self.refresh()
        return sorted(
            (
                record
                for record in records
                if record.enabled
                and record.health_status == "healthy"
                and mode in record.supported_modes
                and (provider is None or record.provider == provider)
            ),
            key=lambda item: (item.priority, item.latency_weight - item.quality_weight),
        )

    def mark_result(self, provider: str, model_id: str, *, success: bool) -> None:
        with self._lock:
            key = (provider, model_id)
            record = self._records.get(key)
            if record:
                self._records[key] = replace(
                    record,
                    health_status="healthy" if success else "degraded",
                    last_health_check=datetime.now(timezone.utc),
                )

    @staticmethod
    def _discover_groq() -> set[str]:
        try:
            models = groq_service._client().models.list()  # provider discovery is metadata-only
            return {str(item.id) for item in getattr(models, "data", []) if getattr(item, "id", None)}
        except Exception as exc:
            logger.warning("model_registry_discovery provider=groq success=false error_type=%s", type(exc).__name__)
            return set()

    @staticmethod
    def _discover_bedrock() -> set[str]:
        if not (settings.bedrock_api_key or (settings.aws_access_key_id and settings.aws_secret_access_key)):
            return set()
        if settings.bedrock_endpoint_mode.lower() != "mantle":
            # Runtime model discovery requires IAM APIs not included in this deployment.
            return set(settings.BEDROCK_RESEARCH_MODELS)
        try:
            response = httpx.get(
                f"{settings.bedrock_mantle_base_url}/models",
                headers=groq_service._bedrock_mantle_headers(),
                timeout=8,
            )
            response.raise_for_status()
            body = response.json()
            return {
                str(item.get("id"))
                for item in body.get("data", [])
                if isinstance(item, dict) and item.get("id")
            }
        except Exception as exc:
            logger.warning("model_registry_discovery provider=bedrock success=false error_type=%s", type(exc).__name__)
            return set()


model_registry = ModelRegistry()
