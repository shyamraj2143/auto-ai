from __future__ import annotations

from dataclasses import dataclass

from app.core.config import settings
from app.services.orchestration.schemas import IntelligenceMode, ModelRecord


@dataclass(frozen=True)
class PresetPolicy:
    mode: IntelligenceMode
    providers: frozenset[str]
    requires_web_research: bool = False
    exact_model_count: int | None = None


PRESET_POLICIES = {
    IntelligenceMode.INSTANT: PresetPolicy(IntelligenceMode.INSTANT, frozenset({"groq"}), exact_model_count=1),
    IntelligenceMode.MEDIUM: PresetPolicy(IntelligenceMode.MEDIUM, frozenset({"groq"})),
    IntelligenceMode.HIGH: PresetPolicy(IntelligenceMode.HIGH, frozenset({"groq", "bedrock"})),
    IntelligenceMode.DEEP_RESEARCH: PresetPolicy(
        IntelligenceMode.DEEP_RESEARCH,
        frozenset({"groq", "bedrock"}),
        requires_web_research=True,
    ),
    IntelligenceMode.CODING: PresetPolicy(
        IntelligenceMode.CODING,
        frozenset({"groq", "bedrock"}),
        exact_model_count=2,
    ),
}


def is_qwen_coder(model_id: str | None) -> bool:
    value = (model_id or "").lower()
    return "qwen" in value and "coder" in value


def coding_configuration_status(records: list[ModelRecord]) -> tuple[bool, str | None]:
    configured = {
        "groq": settings.ORCHESTRATION_GROQ_CODING_MODEL,
        "bedrock": settings.ORCHESTRATION_BEDROCK_CODING_MODEL,
    }
    labels = {"groq": "Groq", "bedrock": "Amazon Bedrock"}
    for provider in ("groq", "bedrock"):
        model_id = configured[provider]
        if not model_id:
            return False, f"{labels[provider]} Qwen Coder model is not configured."
        if not is_qwen_coder(model_id):
            return False, f"Configured {labels[provider]} coding model is not a Qwen Coder model."
        record = next(
            (item for item in records if item.provider == provider and item.actual_model_id == model_id),
            None,
        )
        if not record or not record.enabled or record.health_status != "healthy":
            return False, f"Configured {labels[provider]} Qwen Coder model is unavailable."
        if not {"text", "chat", "coding"}.issubset(record.capabilities):
            return False, f"Configured {labels[provider]} Qwen Coder model is not text-chat compatible."
    return True, None


def coding_model_ids() -> tuple[str | None, str | None]:
    return settings.ORCHESTRATION_GROQ_CODING_MODEL, settings.ORCHESTRATION_BEDROCK_CODING_MODEL
