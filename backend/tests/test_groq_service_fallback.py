from fastapi import HTTPException

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


    service = GroqService()

    def unavailable(detail):
        def fail(*args, **kwargs):
            raise HTTPException(status_code=503, detail=detail)
        return fail

    monkeypatch.setattr(service, "_complete_groq", unavailable("groq unavailable"))
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "configured")
    monkeypatch.setattr(
        service,
        "_complete_openai",
        lambda *args, **kwargs: ("OpenAI fallback", {"total_tokens": 2}, kwargs["model"]),
    )

        [{"role": "user", "content": "Hi"}],
        allow_fallback=True,
    )

    assert content == "OpenAI fallback"
    assert usage["total_tokens"] == 2
    assert model == settings.OPENAI_MODEL
