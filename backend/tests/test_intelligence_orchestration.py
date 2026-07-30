import threading
import time
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.core.config import settings

from app.models.chat_generation import OrchestrationEvent
from app.schemas.chat import ChatRequest
from app.services.orchestration.activity_store import _sanitize, activity_store
from app.services.orchestration.citation_verifier import citation_verifier
from app.services.orchestration.orchestrator import intelligence_orchestrator
from app.services.orchestration.parallel_executor import parallel_executor
from app.services.orchestration.provider_adapters import provider_adapter
from app.services.orchestration.schemas import (
    IntelligenceMode,
    ModelRecord,
    ModelResult,
    ModelTask,
    TaskStatus,
)
from app.services.orchestration.task_planner import task_planner
from app.services.orchestration.model_registry import ModelRegistry
from app.services.web_search import web_search_service


MESSAGES = [{"role": "user", "content": "Explain the safest production design."}]


def test_chat_request_accepts_legacy_max_models_without_enforcing_old_cap():
    assert ChatRequest(message="test", max_models=20).max_models == 20


def test_registry_includes_all_available_chat_models_and_excludes_incompatible(monkeypatch):
    registry = ModelRegistry()
    monkeypatch.setattr(settings, "ORCHESTRATION_INCLUDE_ALL_AVAILABLE_MODELS", True)
    monkeypatch.setattr(registry, "_discover_groq", lambda: {"groq-chat-a", "audio-whisper"})
    monkeypatch.setattr(registry, "_discover_bedrock", lambda: {"bedrock-chat-a", "mistral.voxtral-audio"})
    registry.refresh(force=True)
    assert {(item.provider, item.actual_model_id) for item in registry.eligible(IntelligenceMode.HIGH)} == {
        ("groq", "groq-chat-a"),
        ("bedrock", "bedrock-chat-a"),
    }


def test_serper_sends_required_q_parameter(monkeypatch):
    captured = {}

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"organic": []}

    monkeypatch.setattr(settings, "SERPER_API_KEY", "test-only")
    monkeypatch.setattr(
        "app.services.web_search.httpx.post",
        lambda _url, **kwargs: captured.update(kwargs) or Response(),
    )
    web_search_service._search_serper("verified query", "deep")
    assert captured["json"]["q"] == "verified query"


def record(model_id: str, provider: str = "groq", quality: float = 1.0) -> ModelRecord:
    return ModelRecord(
        provider=provider,
        friendly_name=model_id,
        actual_model_id=model_id,
        enabled=True,
        supported_modes=frozenset(IntelligenceMode),
        health_status="healthy",
        quality_weight=quality,
        timeout_seconds=0.1,
    )


def task(model_id: str, provider: str = "groq", quality: float = 1.0) -> ModelTask:
    return ModelTask(
        task_id=str(uuid.uuid4()),
        model=record(model_id, provider, quality),
        role="Technical reviewer",
        activity_label="Reviewing technical accuracy",
        messages=MESSAGES,
    )


def install_synthesis_stub(monkeypatch):
    monkeypatch.setattr(
        "app.services.orchestration.orchestrator.response_synthesizer.synthesize",
        lambda _message, results, max_tokens: (
            "\n".join(result.content for result in results),
            {},
            f"{results[0].task.model.provider}/{results[0].task.model.actual_model_id}",
        ),
    )


def run(mode: str, events: list[tuple[str, dict]]):
    return intelligence_orchestrator.run(
        MESSAGES,
        mode=mode,
        emit=lambda event, payload: events.append((event, payload)),
        cancelled=lambda: False,
    )


def test_instant_calls_only_primary_on_success(monkeypatch):
    tasks = [task("primary"), task("fallback")]
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: tasks)
    called = []

    def complete(model_task, *, max_tokens):
        called.append(model_task.model.actual_model_id)
        return ModelResult(model_task, TaskStatus.COMPLETED, content="primary answer")

    monkeypatch.setattr(provider_adapter, "complete", complete)
    install_synthesis_stub(monkeypatch)
    result = run("instant", [])
    assert result.content == "primary answer"
    assert called == ["primary"]


def test_instant_uses_fallback_after_primary_failure(monkeypatch):
    tasks = [task("primary-failure"), task("fallback-success")]
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: tasks)
    called = []

    def complete(model_task, *, max_tokens):
        called.append(model_task.model.actual_model_id)
        if model_task.model.actual_model_id == "primary-failure":
            raise ConnectionError("provider unavailable")
        return ModelResult(model_task, TaskStatus.COMPLETED, content="fallback answer")

    monkeypatch.setattr(provider_adapter, "complete", complete)
    install_synthesis_stub(monkeypatch)
    result = run("instant", [])
    assert result.content == "fallback answer"
    assert called[-1] == "fallback-success"


def test_medium_runs_models_concurrently_and_survives_failure(monkeypatch):
    tasks = [task("medium-a"), task("medium-b"), task("medium-c")]
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: tasks)
    install_synthesis_stub(monkeypatch)
    lock = threading.Lock()
    active = 0
    maximum = 0

    def complete(model_task, *, max_tokens):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.03)
        with lock:
            active -= 1
        if model_task.model.actual_model_id == "medium-b":
            raise RuntimeError("bad model")
        return ModelResult(model_task, TaskStatus.COMPLETED, content=model_task.model.actual_model_id)

    monkeypatch.setattr(provider_adapter, "complete", complete)
    result = run("medium", [])
    assert maximum >= 2
    assert "medium-a" in result.content
    assert "medium-c" in result.content


def test_medium_plans_every_healthy_configured_groq_model(monkeypatch):
    records = [record(f"groq-{index}") for index in range(6)]
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.eligible",
        lambda _mode: records,
    )
    planned = task_planner.plan(
        IntelligenceMode.MEDIUM,
        type("Analysis", (), {"complexity": "low"})(),
        MESSAGES,
    )
    assert [item.model.actual_model_id for item in planned] == [f"groq-{index}" for index in range(6)]
    assert len({item.role for item in planned}) == 6


def test_high_combines_actual_groq_and_bedrock_tasks(monkeypatch):
    tasks = [task("groq-high", "groq"), task("nova-high", "bedrock")]
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: tasks)
    monkeypatch.setattr(
        provider_adapter,
        "complete",
        lambda model_task, max_tokens: ModelResult(
            model_task, TaskStatus.COMPLETED, content=model_task.model.provider
        ),
    )
    install_synthesis_stub(monkeypatch)
    result = run("high", [])
    providers = {item["provider"] for item in result.metadata["models_consulted"]}
    assert providers == {"groq", "bedrock"}


def test_high_plans_every_healthy_model_without_six_model_cap(monkeypatch):
    records = [
        *[record(f"groq-{index}", "groq") for index in range(6)],
        *[record(f"bedrock-{index}", "bedrock") for index in range(3)],
    ]
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.eligible",
        lambda _mode: records,
    )
    planned = task_planner.plan(
        IntelligenceMode.HIGH,
        type("Analysis", (), {"complexity": "high"})(),
        MESSAGES,
    )
    assert len(planned) == 9
    assert {item.model.provider for item in planned} == {"groq", "bedrock"}


def test_coding_plans_exact_configured_qwen_coder_pair(monkeypatch):
    groq_id = "qwen/qwen-coder-test"
    bedrock_id = "qwen.qwen-coder-test"
    records = [
        ModelRecord(
            **{
                **record(groq_id, "groq").__dict__,
                "capabilities": frozenset({"text", "chat", "coding"}),
            }
        ),
        ModelRecord(
            **{
                **record(bedrock_id, "bedrock").__dict__,
                "capabilities": frozenset({"text", "chat", "coding"}),
            }
        ),
        record("unrelated-model", "groq"),
    ]
    monkeypatch.setattr(settings, "ORCHESTRATION_GROQ_CODING_MODEL", groq_id)
    monkeypatch.setattr(settings, "ORCHESTRATION_BEDROCK_CODING_MODEL", bedrock_id)
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.refresh",
        lambda: records,
    )
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.eligible",
        lambda _mode: records[:2],
    )
    planned = task_planner.plan(
        IntelligenceMode.CODING,
        type("Analysis", (), {"complexity": "high"})(),
        MESSAGES,
    )
    assert [(item.model.provider, item.model.actual_model_id) for item in planned] == [
        ("groq", groq_id),
        ("bedrock", bedrock_id),
    ]


def test_deep_research_requires_verified_web_context():
    with pytest.raises(Exception) as exc:
        run("deep_research", [])
    assert "verified web source context" in str(exc.value)


def test_instant_plans_primary_and_only_one_fallback(monkeypatch):
    records = [
        record(settings.GROQ_MODEL),
        *[record(model_id) for model_id in settings.ORCHESTRATION_INSTANT_FALLBACKS[:3]],
    ]
    monkeypatch.setattr(
        "app.services.orchestration.task_planner.model_registry.eligible",
        lambda _mode: records,
    )
    planned = task_planner.plan(
        IntelligenceMode.INSTANT,
        type("Analysis", (), {"complexity": "low"})(),
        MESSAGES,
    )
    assert len(planned) <= 2
    assert planned[0].model.actual_model_id == settings.GROQ_MODEL


def test_activity_working_and_completed_events_match_real_calls(monkeypatch):
    selected = task("activity-model")
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: [selected])
    monkeypatch.setattr(
        provider_adapter,
        "complete",
        lambda model_task, max_tokens: ModelResult(model_task, TaskStatus.COMPLETED, content="done"),
    )
    install_synthesis_stub(monkeypatch)
    events = []
    run("instant", events)
    names = [name for name, _ in events]
    assert names.index("model.started") < names.index("model.completed")
    completed = [payload for name, payload in events if name == "model.completed"][-1]
    assert completed["task_id"] == selected.task_id
    assert completed["contributed_to_final_answer"] is True


def test_persisted_audit_records_real_status_role_duration_and_contribution(monkeypatch):
    completed_task = task("completed-model")
    failed_task = task("failed-model")
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: [completed_task, failed_task])

    def complete(model_task, *, max_tokens):
        if model_task.model.actual_model_id == "failed-model":
            raise RuntimeError("provider failed")
        return ModelResult(model_task, TaskStatus.COMPLETED, content="done")

    monkeypatch.setattr(provider_adapter, "complete", complete)
    install_synthesis_stub(monkeypatch)
    result = run("medium", [])
    audit = {item["display_name"]: item for item in result.metadata["models_consulted"]}
    assert audit["completed-model"]["status"] == "completed"
    assert audit["completed-model"]["contributed"] is True
    assert audit["completed-model"]["activity_label"] == "Reviewing technical accuracy"
    assert audit["failed-model"]["status"] == "failed"
    assert audit["failed-model"]["contributed"] is False


def test_unselected_model_never_appears_in_activity(monkeypatch):
    selected = task("selected-only")
    monkeypatch.setattr(task_planner, "plan", lambda *_args, **_kwargs: [selected])
    monkeypatch.setattr(
        provider_adapter,
        "complete",
        lambda model_task, max_tokens: ModelResult(model_task, TaskStatus.COMPLETED, content="done"),
    )
    install_synthesis_stub(monkeypatch)
    events = []
    run("instant", events)
    payload_text = str(events)
    assert "selected-only" in payload_text
    assert "not-selected" not in payload_text


def test_timeout_returns_without_waiting_for_slow_model(monkeypatch):
    slow = task("slow-timeout")
    monkeypatch.setattr(
        provider_adapter,
        "complete",
        lambda model_task, max_tokens: (time.sleep(0.3), ModelResult(model_task, TaskStatus.COMPLETED))[1],
    )
    events = []
    started = time.perf_counter()
    results = parallel_executor.execute(
        [slow],
        emit=lambda event, payload: events.append((event, payload)),
        cancelled=lambda: False,
        max_tokens=100,
        total_timeout=0.02,
    )
    assert time.perf_counter() - started < 0.15
    assert results[0].status == TaskStatus.TIMED_OUT
    time.sleep(0.35)
    assert [event for event, _payload in events if event == "model.timed_out"] == ["model.timed_out"]
    assert not [event for event, _payload in events if event == "model.completed"]


def test_cancellation_does_not_start_provider_call(monkeypatch):
    provider_called = False

    def complete(model_task, *, max_tokens):
        nonlocal provider_called
        provider_called = True
        return ModelResult(model_task, TaskStatus.COMPLETED)

    monkeypatch.setattr(provider_adapter, "complete", complete)
    results = parallel_executor.execute(
        [task("cancelled")],
        emit=lambda *_args: None,
        cancelled=lambda: True,
        max_tokens=100,
        total_timeout=1,
    )
    assert results == []
    assert provider_called is False


def test_fake_citation_is_removed_and_not_counted():
    content, verified = citation_verifier.verify(
        "Supported https://primary.example/report and fake https://fake.example/made-up",
        [{"url": "https://primary.example/report", "title": "Primary report"}],
    )
    assert verified == 1
    assert "fake.example" not in content


def test_private_and_loopback_research_urls_are_rejected():
    assert citation_verifier.safe_public_url("http://127.0.0.1/private") is False
    assert citation_verifier.safe_public_url("http://169.254.169.254/latest/meta-data") is False
    assert citation_verifier.safe_public_url("https://primary.example/report") is True


def test_activity_payload_redacts_prompts_and_secrets():
    safe = _sanitize(
        {
            "model_display_name": "GPT-OSS 120B",
            "activity_label": "Reviewing technical accuracy",
            "raw_prompt": "private conversation",
            "authorization": "Bearer secret",
            "api_key": "secret",
        }
    )
    assert safe == {
        "model_display_name": "GPT-OSS 120B",
        "activity_label": "Reviewing technical accuracy",
    }


def test_activity_records_are_isolated_by_owner():
    engine = create_engine("sqlite:///:memory:")
    OrchestrationEvent.__table__.create(engine)
    with Session(engine) as db:
        db.add_all(
            [
                OrchestrationEvent(
                    generation_id="generation-1",
                    user_id="owner-1",
                    sequence=1,
                    event_type="model.started",
                    payload={"event": "model.started", "request_id": "generation-1"},
                ),
                OrchestrationEvent(
                    generation_id="generation-1",
                    user_id="owner-2",
                    sequence=2,
                    event_type="model.started",
                    payload={"event": "model.started", "request_id": "generation-1"},
                ),
            ]
        )
        db.commit()
        rows = activity_store.list("generation-1", "owner-1", session=db)
        assert [row.user_id for row in rows] == ["owner-1"]


@pytest.mark.parametrize(
    ("legacy", "canonical"),
    [("normal", IntelligenceMode.INSTANT), ("multi_model", IntelligenceMode.MEDIUM)],
)
def test_legacy_modes_remain_backward_compatible(legacy, canonical):
    assert IntelligenceMode.canonical(legacy) == canonical
