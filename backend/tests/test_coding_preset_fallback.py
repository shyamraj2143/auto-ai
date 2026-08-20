import uuid

from app.core.config import settings
from app.services.orchestration.orchestrator import intelligence_orchestrator
from app.services.orchestration.preset_policy import (
    coding_configuration_status,
    coding_fallback_used,
    coding_task_records,
)
from app.services.orchestration.schemas import (
    IntelligenceMode,
    ModelRecord,
    ModelResult,
    ModelTask,
    TaskStatus,
)
from app.services.orchestration.task_planner import task_planner


MESSAGES = [{"role": "user", "content": "Build a secure HTML storefront."}]


def record(model_id: str, provider: str = "groq", quality: float = 1.0) -> ModelRecord:
    return ModelRecord(
        provider=provider,
        friendly_name=model_id,
        actual_model_id=model_id,
        enabled=True,
        supported_modes=frozenset(IntelligenceMode),
        capabilities=frozenset({"text", "chat", "coding"} if "coder" in model_id else {"text", "chat"}),
        health_status="healthy",
        quality_weight=quality,
        timeout_seconds=0.1,
    )


    records = [
        record("qwen/qwen3-32b", quality=1.2),
        record("openai/gpt-oss-120b", quality=1.4),
        record("llama-3.3-70b-versatile", quality=1.1),
    ]
    monkeypatch.setattr(settings, "ORCHESTRATION_GROQ_CODING_MODEL", None)
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.refresh",
        lambda: records,
    )
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.eligible",
        lambda _mode: records,
    )

    assert coding_configuration_status(records) == (True, None)
    assert coding_fallback_used(records) is True
    assert [item.actual_model_id for item in coding_task_records(records)] == [
        "qwen/qwen3-32b",
        "openai/gpt-oss-120b",
    ]

    planned = task_planner.plan(
        IntelligenceMode.CODING,
        type("Analysis", (), {"complexity": "high"})(),
        MESSAGES,
    )
    assert [item.model.actual_model_id for item in planned] == [
        "qwen/qwen3-32b",
        "openai/gpt-oss-120b",
    ]
    assert [item.role for item in planned] == [
        "Coding implementation specialist",
        "Code review and security specialist",
    ]


    records = [
        record("qwen/qwen3-32b", "groq", quality=1.2),
        record("openai/gpt-oss-120b", "groq", quality=1.4),
        record("amazon.nova-pro-v1:0", quality=1.4),
    ]
    monkeypatch.setattr(settings, "ORCHESTRATION_GROQ_CODING_MODEL", None)

    selected = coding_task_records(records)
    assert [(item.provider, item.actual_model_id) for item in selected] == [
        ("groq", "qwen/qwen3-32b"),
        ("amazon.nova-pro-v1:0"),
    ]
    assert coding_configuration_status(records) == (True, None)
    assert coding_fallback_used(records) is False


def test_coding_orchestrator_reports_same_provider_fallback(monkeypatch):
    models = [record("qwen/qwen3-32b"), record("openai/gpt-oss-120b")]
    tasks = [
        ModelTask(
            task_id=str(uuid.uuid4()),
            model=model,
            role="Coding implementation specialist" if index == 0 else "Code review and security specialist",
            activity_label="Preparing implementation" if index == 0 else "Reviewing implementation",
            messages=MESSAGES,
        )
        for index, model in enumerate(models)
    ]
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: tasks)
    monkeypatch.setattr(
        "app.services.orchestration.orchestrator.parallel_executor.execute",
        lambda planned, **_kwargs: [
            ModelResult(task=item, status=TaskStatus.COMPLETED, content=f"answer from {item.model.actual_model_id}")
            for item in planned
        ],
    )
    monkeypatch.setattr(
        "app.services.orchestration.orchestrator.response_synthesizer.synthesize",
        lambda _message, results, max_tokens: (
            "combined coding answer",
            {},
            results[0].task.model.actual_model_id,
        ),
    )

    events: list[tuple[str, dict]] = []
    result = intelligence_orchestrator.run(
        MESSAGES,
        mode="coding",
        emit=lambda event, payload: events.append((event, payload)),
        cancelled=lambda: False,
    )

    assert result.content == "combined coding answer"
    assert result.metadata["fallback_used"] is True
    assert any(
        event == "model.progress" and payload.get("fallback_used") is True
        for event, payload in events
    )
