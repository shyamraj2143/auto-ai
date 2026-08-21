import uuid

from app.services.orchestration.preset_policy import coding_configuration_status, coding_fallback_used, coding_task_records
from app.services.orchestration.schemas import IntelligenceMode, ModelRecord, ModelResult, ModelTask, TaskStatus
from app.services.orchestration.task_planner import task_planner
from app.services.orchestration.orchestrator import intelligence_orchestrator


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


def test_coding_accepts_two_healthy_groq_models():
    records = [
        record("qwen/qwen3-32b", quality=1.2),
        record("openai/gpt-oss-120b", quality=1.4),
    ]
    assert coding_configuration_status(records) == (True, None)
    assert coding_fallback_used(records) is False
    assert [item.actual_model_id for item in coding_task_records(records)] == [
        "qwen/qwen3-32b",
        "openai/gpt-oss-120b",
    ]


def test_coding_can_use_openai_as_second_provider():
    records = [
        record("qwen/qwen3-32b", "groq", quality=1.2),
        record("gpt-4.1-mini", "openai", quality=1.4),
    ]
    selected = coding_task_records(records)
    assert [(item.provider, item.actual_model_id) for item in selected] == [
        ("groq", "qwen/qwen3-32b"),
        ("openai", "gpt-4.1-mini"),
    ]
    assert coding_configuration_status(records) == (True, None)


def test_coding_reports_unavailable_when_fewer_than_two_models():
    records = [record("gpt-4.1-mini", "openai", quality=1.4)]
    assert coding_configuration_status(records)[0] is False
    assert coding_fallback_used(records) is True


def test_orchestrator_marks_cross_provider_execution_as_fallback(monkeypatch):
    models = [record("qwen/qwen3-32b", "groq"), record("gpt-4.1-mini", "openai")]
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
        lambda planned, **_kwargs: [ModelResult(task=item, status=TaskStatus.COMPLETED, content=f"answer from {item.model.actual_model_id}") for item in planned],
    )
    monkeypatch.setattr(
        "app.services.orchestration.orchestrator.response_synthesizer.synthesize",
        lambda _message, results, max_tokens: ("combined coding answer", {}, results[0].task.model.actual_model_id),
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
    assert any(event == "model.progress" and payload.get("fallback_used") is True for event, payload in events)
