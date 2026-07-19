from fastapi import HTTPException
import httpx
import pytest

from app.core.config import settings
from app.services.groq_service import GroqService


def test_groq_stream_tries_stable_fallback_after_selected_model_failure(monkeypatch):
    service = GroqService()
    attempted: list[str] = []

    monkeypatch.setattr(service, "selected_provider", lambda provider=None: "groq")
    monkeypatch.setattr(service, "selected_model", lambda model=None, **_: model or "bad-model")

    def fake_stream(_messages, *, model, temperature=None):
        attempted.append(model)
        if model == "bad-model":
            raise HTTPException(status_code=502, detail="model unavailable")
        yield {"choices": [{"delta": {"content": "ok"}}]}

    monkeypatch.setattr(service, "_stream_groq", fake_stream)

    chunks = list(service.stream([{"role": "user", "content": "Hi"}], model="bad-model", provider="groq"))

    assert attempted[:2] == ["bad-model", "openai/gpt-oss-120b"]
    assert chunks == [{"choices": [{"delta": {"content": "ok"}}]}]


def test_groq_complete_tries_stable_fallback_after_selected_model_failure(monkeypatch):
    service = GroqService()
    attempted: list[str] = []

    monkeypatch.setattr(service, "selected_provider", lambda provider=None: "groq")
    monkeypatch.setattr(service, "selected_model", lambda model=None, **_: model or "bad-model")

    def fake_complete(_messages, *, model, temperature=None, max_tokens=None, request_timeout=None):
        attempted.append(model)
        if model == "bad-model":
            raise HTTPException(status_code=502, detail="model unavailable")
        return "ok", {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}, model

    monkeypatch.setattr(service, "_complete_groq", fake_complete)

    content, usage, model = service.complete([{"role": "user", "content": "Hi"}], model="bad-model", provider="groq")

    assert attempted[:2] == ["bad-model", "openai/gpt-oss-120b"]
    assert content == "ok"
    assert usage["total_tokens"] == 2
    assert model == "openai/gpt-oss-120b"


def test_bedrock_mantle_uses_only_mantle_model_and_adapter(monkeypatch):
    service = GroqService()
    calls: list[str] = []
    monkeypatch.setattr(
        type(settings),
        "bedrock_endpoint_mode",
        property(lambda _: "mantle"),
    )
    monkeypatch.setattr(
        service,
        "_complete_bedrock_mantle",
        lambda *args, **kwargs: (calls.append(kwargs["model"]) or ("ok", {}, kwargs["model"])),
    )
    monkeypatch.setattr(service, "_complete_bedrock_runtime", lambda *args, **kwargs: pytest.fail("runtime adapter must not be called"))

    content, _, model = service._complete_bedrock(
        [{"role": "user", "content": "Hi"}],
        model="openai.gpt-oss-120b",
        allow_fallback=False,
    )

    assert content == "ok"
    assert model == "openai.gpt-oss-120b"
    assert calls == ["openai.gpt-oss-120b"]


def test_bedrock_runtime_rejects_mantle_model_name() -> None:
    with pytest.raises(HTTPException) as exc:
        GroqService._validate_bedrock_model("runtime", "openai.gpt-oss-120b")
    assert exc.value.status_code == 503
    assert "openai.gpt-oss-120b-1:0" in str(exc.value.detail)


def test_bedrock_mantle_rejects_runtime_model_id() -> None:
    with pytest.raises(HTTPException) as exc:
        GroqService._validate_bedrock_model("mantle", "openai.gpt-oss-120b-1:0")
    assert exc.value.status_code == 503
    assert "openai.gpt-oss-120b" in str(exc.value.detail)


def test_bedrock_malformed_completion_is_rejected() -> None:
    response = httpx.Response(200, json={"choices": []})
    with pytest.raises(HTTPException) as exc:
        GroqService._bedrock_chat_completion(response, "openai.gpt-oss-120b")
    assert exc.value.status_code == 502
