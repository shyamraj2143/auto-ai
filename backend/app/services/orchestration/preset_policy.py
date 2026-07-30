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


def _coding_rank(record: ModelRecord, configured_model: str | None) -> tuple[int, int, float, int]:
    model_id = record.actual_model_id.lower()
    if configured_model and record.actual_model_id == configured_model and is_qwen_coder(model_id):
        family_rank = 0
    elif is_qwen_coder(model_id):
        family_rank = 1
    elif "qwen" in model_id:
        family_rank = 2
    else:
        family_rank = 3
    variant_rank = (
        0 if "coder-480b" in model_id
        else 1 if "coder-next" in model_id
        else 2 if "coder" in model_id
        else 3
    )
    return family_rank, variant_rank, -record.quality_weight, record.priority


def coding_model_records(records: list[ModelRecord]) -> tuple[ModelRecord | None, ModelRecord | None]:
    configured = {
        "groq": settings.ORCHESTRATION_GROQ_CODING_MODEL,
        "bedrock": settings.ORCHESTRATION_BEDROCK_CODING_MODEL,
    }
    selected: list[ModelRecord | None] = []
    for provider in ("groq", "bedrock"):
        candidates = [
            record
            for record in records
            if record.provider == provider
            and record.enabled
            and record.health_status == "healthy"
            and {"text", "chat"}.issubset(record.capabilities)
            and "qwen" in record.actual_model_id.lower()
        ]
        candidates.sort(key=lambda record: _coding_rank(record, configured[provider]))
        selected.append(candidates[0] if candidates else None)
    return selected[0], selected[1]


def coding_configuration_status(records: list[ModelRecord]) -> tuple[bool, str | None]:
    groq_model, bedrock_model = coding_model_records(records)
    if not groq_model:
        return False, "No healthy Groq Qwen text-chat model is available for coding."
    if not bedrock_model:
        return False, "No healthy Amazon Bedrock Qwen model is available for coding."
    return True, None


def coding_model_ids(records: list[ModelRecord]) -> tuple[str | None, str | None]:
    groq_model, bedrock_model = coding_model_records(records)
    return (
        groq_model.actual_model_id if groq_model else None,
        bedrock_model.actual_model_id if bedrock_model else None,
    )
