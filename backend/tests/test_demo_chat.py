from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes import demo_chat
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.demo_chat import DemoChatSession


def demo_client() -> tuple[TestClient, Session]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    app = FastAPI()
    app.include_router(demo_chat.router, prefix="/api/v1")

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    return TestClient(app), db


def payload(session_id: str = "demo-session-0001", message: str = "Hello") -> dict:
    return {
        "session_id": session_id,
        "message": message,
        "mode": "chat",
        "history": [{"role": "assistant", "content": "Welcome to Auto-AI."}],
    }


def test_demo_chat_uses_bedrock_without_fallback_and_stores_no_chat(monkeypatch) -> None:
    client, db = demo_client()
    calls: list[tuple[list[dict], dict]] = []

    def fake_complete(messages, **kwargs):
        calls.append((messages, kwargs))
        return "Real Bedrock demo answer", {"prompt_tokens": 8, "completion_tokens": 5, "total_tokens": 13}, "amazon.nova-lite-v1:0"

    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_MAX_RETRIES", 1)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_RETRY_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(demo_chat.groq_service, "complete", fake_complete)

    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 200
    assert response.json() == {
        "content": "Real Bedrock demo answer",
        "provider": "bedrock",
        "model": "amazon.nova-lite-v1:0",
        "messages_used": 1,
        "remaining": 4,
    }
    assert calls[0][1]["provider"] == "bedrock"
    assert calls[0][1]["allow_bedrock_fallback"] is False
    assert calls[0][0][-1] == {"role": "user", "content": "Hello"}
    assert (db.scalar(select(func.count()).select_from(Chat)) or 0) == 0
    usage = db.scalar(select(APIUsage))
    assert usage is not None
    assert usage.provider == "bedrock"
    assert usage.endpoint == "public_demo_chat"
    db.close()


def test_demo_chat_enforces_server_side_limit(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 2)
    monkeypatch.setattr(
        demo_chat.groq_service,
        "complete",
        lambda messages, **kwargs: ("Bedrock answer", {}, "amazon.nova-lite-v1:0"),
    )

    assert client.post("/api/v1/demo/chat", json=payload()).status_code == 200
    second = client.post("/api/v1/demo/chat", json=payload(message="Second"))
    blocked = client.post("/api/v1/demo/chat", json=payload(message="Third"))

    assert second.status_code == 200
    assert second.json()["remaining"] == 0
    assert blocked.status_code == 429
    assert db.get(DemoChatSession, "demo-session-0001").messages_used == 2
    db.close()


def test_demo_chat_releases_quota_and_returns_structured_error_when_bedrock_fails(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_MAX_RETRIES", 1)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_RETRY_BACKOFF_SECONDS", 0)
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise HTTPException(status_code=503, detail="provider unavailable")

    monkeypatch.setattr(demo_chat.groq_service, "complete", fail)
    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_UNAVAILABLE"
    assert response.json()["error"]["message"] == "AI service is temporarily unavailable."
    assert response.json()["error"]["request_id"] == response.headers["x-request-id"]
    assert calls == 2
    assert db.get(DemoChatSession, "demo-session-0001").messages_used == 0
    db.close()


def test_demo_chat_config_exposes_active_bedrock_model(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    response = client.get("/api/v1/demo/chat/config")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "provider": "bedrock",
        "model": settings.bedrock_model,
        "limit": 5,
    }
    db.close()


def test_demo_chat_maps_access_denied_without_retry(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_MAX_RETRIES", 1)
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise HTTPException(status_code=403, detail="access denied")

    monkeypatch.setattr(demo_chat.groq_service, "complete", fail)
    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_CONFIGURATION_ERROR"
    assert calls == 1
    db.close()


def test_demo_chat_maps_throttling_after_bounded_retry(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_MAX_RETRIES", 1)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_RETRY_BACKOFF_SECONDS", 0)
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise HTTPException(status_code=429, detail="throttled")

    monkeypatch.setattr(demo_chat.groq_service, "complete", fail)
    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "PROVIDER_RATE_LIMITED"
    assert calls == 2
    db.close()


def test_demo_chat_maps_timeout_without_retry(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_MAX_RETRIES", 1)
    calls = 0

    def fail(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise HTTPException(status_code=504, detail="timeout")

    monkeypatch.setattr(demo_chat.groq_service, "complete", fail)
    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 504
    assert response.json()["error"]["code"] == "PROVIDER_TIMEOUT"
    assert calls == 1
    db.close()


def test_demo_chat_rejects_empty_provider_response(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 5)
    monkeypatch.setattr(demo_chat.groq_service, "complete", lambda *args, **kwargs: ("", {}, "openai.gpt-oss-120b"))

    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "PROVIDER_INVALID_RESPONSE"
    assert db.get(DemoChatSession, "demo-session-0001").messages_used == 0
    db.close()
