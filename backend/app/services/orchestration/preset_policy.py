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


def _healthy_chat_records(records: list[ModelRecord]) -> list[ModelRecord]:
    return [
        record
        for record in records
        if record.enabled
        and record.health_status == "healthy"
        and {"text", "chat"}.issubset(record.capabilities)
    ]


def _configured_coding_model(provider: str) -> str | None:
    return (
        settings.ORCHESTRATION_GROQ_CODING_MODEL
        if provider == "groq"
        else settings.ORCHESTRATION_BEDROCK_CODING_MODEL
    )


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
    """Return the best healthy model for each preferred coding provider.

    Qwen Coder remains the first choice, but a provider's strongest healthy
    text-chat model is accepted as a runtime fallback. This prevents the entire
    preset from being disabled just because one specifically named model is not
    listed by the provider discovery endpoint.
    """

    healthy = _healthy_chat_records(records)
    selected: list[ModelRecord | None] = []
    for provider in ("groq", "bedrock"):
        candidates = [record for record in healthy if record.provider == provider]
        configured = _configured_coding_model(provider)
        candidates.sort(key=lambda record: _coding_rank(record, configured))
        selected.append(candidates[0] if candidates else None)
    return selected[0], selected[1]


def coding_task_records(records: list[ModelRecord]) -> list[ModelRecord]:
    """Select two distinct healthy coding workers with graceful provider fallback.

    The ideal pair is Groq + Bedrock. When Bedrock is unavailable, two distinct
    Groq models are used for implementation and review. The same rule works in
    reverse for a Bedrock-only deployment. Requiring two workers preserves the
    coding preset's implementation-plus-review contract.
    """

    healthy = _healthy_chat_records(records)
    groq_model, bedrock_model = coding_model_records(records)
    selected = [record for record in (groq_model, bedrock_model) if record is not None]
    selected_keys = {(record.provider, record.actual_model_id) for record in selected}
    selected_providers = {record.provider for record in selected}

    remaining = [
        record
        for record in healthy
        if (record.provider, record.actual_model_id) not in selected_keys
    ]
    remaining.sort(
        key=lambda record: (
            0 if record.provider not in selected_providers else 1,
            *_coding_rank(record, _configured_coding_model(record.provider)),
        )
    )
    for record in remaining:
        if len(selected) >= 2:
            break
        selected.append(record)
        selected_providers.add(record.provider)
    return selected[:2]


def coding_configuration_status(records: list[ModelRecord]) -> tuple[bool, str | None]:
    selected = coding_task_records(records)
    if len(selected) >= 2:
        return True, None

    groq_model, bedrock_model = coding_model_records(records)
    if not groq_model:
        return False, "No healthy Groq text-chat model is available for coding."
    if not bedrock_model:
        return False, "No healthy Amazon Bedrock Qwen model is available for coding."
    return False, "Coding requires two distinct healthy text-chat models."


def coding_model_ids(records: list[ModelRecord]) -> tuple[str | None, str | None]:
    groq_model, bedrock_model = coding_model_records(records)
    return (
        groq_model.actual_model_id if groq_model else None,
        bedrock_model.actual_model_id if bedrock_model else None,
    )


def coding_fallback_used(records: list[ModelRecord]) -> bool:
    selected = coding_task_records(records)
    return len(selected) < 2 or {record.provider for record in selected} != {"groq", "bedrock"}
