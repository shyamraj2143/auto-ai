from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Callable


class IntelligenceMode(StrEnum):
    INSTANT = "instant"
    MEDIUM = "medium"
    HIGH = "high"
    DEEP_RESEARCH = "deep_research"

    @classmethod
    def canonical(cls, value: str | None) -> "IntelligenceMode":
        aliases = {"normal": cls.INSTANT, "multi_model": cls.MEDIUM}
        if value in aliases:
            return aliases[value]
        return cls(value or cls.INSTANT)


class TaskStatus(StrEnum):
    QUEUED = "queued"
    WORKING = "working"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    TIMED_OUT = "timed_out"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True)
class ModelRecord:
    provider: str
    friendly_name: str
    actual_model_id: str
    enabled: bool
    supported_modes: frozenset[IntelligenceMode]
    capabilities: frozenset[str] = frozenset({"text"})
    context_window: int = 8192
    supports_streaming: bool = False
    supports_tools: bool = False
    supports_vision: bool = False
    priority: int = 100
    cost_weight: float = 1.0
    latency_weight: float = 1.0
    quality_weight: float = 1.0
    timeout_seconds: float = 45
    fallback_model: str | None = None
    required_region: str | None = None
    health_status: str = "unknown"
    last_health_check: datetime | None = None


@dataclass(frozen=True)
class RequestAnalysis:
    intent: str
    language: str
    complexity: str
    expertise: str
    response_format: str
    needs_current_information: bool
    safety_review: bool
    token_budget: int
    latency_budget_seconds: int


@dataclass(frozen=True)
class ModelTask:
    task_id: str
    model: ModelRecord
    role: str
    activity_label: str
    messages: list[dict[str, str]]


@dataclass
class ModelResult:
    task: ModelTask
    status: TaskStatus
    content: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    duration_ms: int = 0
    error_classification: str | None = None
    contributed: bool = False


@dataclass
class OrchestrationResult:
    content: str
    usage: dict[str, int]
    selected_model: str
    metadata: dict


ActivityCallback = Callable[[str, dict], None]
CancelCallback = Callable[[], bool]
SynthesisCallback = Callable[[str], None]


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
