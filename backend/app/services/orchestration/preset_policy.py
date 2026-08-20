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
    IntelligenceMode.HIGH: PresetPolicy(IntelligenceMode.HIGH, frozenset({"groq"})),
    IntelligenceMode.DEEP_RESEARCH: PresetPolicy(
        IntelligenceMode.DEEP_RESEARCH,
        frozenset({"groq"}),
        requires_web_research=True,
    ),
    IntelligenceMode.CODING: PresetPolicy(
        IntelligenceMode.CODING,
        frozenset({"groq"}),
        exact_model_count=2,
    ),
}


def is_qwen_coder(model_id: str | None) -> bool:
    value = (model_id or "").lower()
    return "qwen" in value and "coder" in value


def _healthy_chat_records(records: list[ModelRecord]) -> list[ModelRecord]:
    return [
        record
        for record in records
        if record.enabled
        and record.health_status == "healthy"
        and {"text", "chat"}.issubset(record.capabilities)
    ]


def _configured_coding_model(provider: str) -> str | None:
    return settings.ORCHESTRATION_GROQ_CODING_MODEL if provider == "groq" else None


def _coding_rank(record: ModelRecord, configured_model: str | None) -> tuple[int, int, float, float, int]:
    model_id = record.actual_model_id.lower()
    if configured_model and record.actual_model_id == configured_model:
        family_rank = 0
    elif is_qwen_coder(model_id):
        family_rank = 1
    elif "qwen" in model_id:
        family_rank = 2
    elif "coding" in record.capabilities or "coder" in model_id or "code" in model_id:
        family_rank = 3
    else:
        family_rank = 4
    variant_rank = (
        0 if "coder-480b" in model_id
        else 1 if "coder-next" in model_id
        else 2 if "coder" in model_id
        else 3
    )
    return family_rank, variant_rank, -record.quality_weight, record.latency_weight, record.priority


def coding_model_records(records: list[ModelRecord]) -> tuple[ModelRecord | None, ModelRecord | None]:
    healthy = _healthy_chat_records(records)
    candidates = [record for record in healthy if record.provider == "groq"]
    candidates.sort(key=lambda record: _coding_rank(record, _configured_coding_model("groq")))
    first = candidates[0] if candidates else None
    second = next((record for record in candidates[1:] if record.actual_model_id != (first.actual_model_id if first else None)), None)
    return first, second


def coding_task_records(records: list[ModelRecord]) -> list[ModelRecord]:
    healthy = [record for record in _healthy_chat_records(records) if record.provider == "groq"]
    healthy.sort(key=lambda record: _coding_rank(record, _configured_coding_model("groq")))
    return healthy[:2]


def coding_configuration_status(records: list[ModelRecord]) -> tuple[bool, str | None]:
    selected = coding_task_records(records)
    if len(selected) >= 2:
        return True, None
    return False, "Coding requires two distinct healthy Groq text-chat models."


def coding_model_ids(records: list[ModelRecord]) -> tuple[str | None, str | None]:
    first, second = coding_model_records(records)
    return (first.actual_model_id if first else None, second.actual_model_id if second else None)


def coding_fallback_used(records: list[ModelRecord]) -> bool:
    selected = coding_task_records(records)
    return len(selected) < 2
