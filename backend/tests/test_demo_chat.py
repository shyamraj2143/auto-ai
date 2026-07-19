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


def test_demo_chat_prefers_bedrock_with_fallback_and_stores_no_chat(monkeypatch) -> None:
    client, db = demo_client()
    calls: list[tuple[list[dict], dict]] = []

    def fake_complete(messages, **kwargs):
        calls.append((messages, kwargs))
        return "Real Bedrock demo answer", {"prompt_tokens": 8, "completion_tokens": 5, "total_tokens": 13}, settings.bedrock_model

    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 20)
    monkeypatch.setattr(demo_chat.groq_service, "complete", fake_complete)

    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 200
    assert response.json() == {
        "content": "Real Bedrock demo answer",
        "provider": "bedrock",
        "model": settings.bedrock_model,
        "messages_used": 1,
        "remaining": 4,
    }
    assert calls[0][1]["provider"] == "bedrock"
    assert calls[0][1]["allow_bedrock_fallback"] is True
    assert calls[0][0][-1] == {"role": "user", "content": "Hello"}
    assert (db.scalar(select(func.count()).select_from(Chat)) or 0) == 0
    usage = db.scalar(select(APIUsage))
    assert usage is not None
    assert usage.provider == "bedrock"
    assert usage.endpoint == "public_demo_chat"
    db.close()


def test_demo_chat_reports_groq_when_bedrock_falls_back(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 20)
    monkeypatch.setattr(
        demo_chat.groq_service,
        "complete",
        lambda messages, **kwargs: (
            "Fallback answer",
            {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
            "openai/gpt-oss-120b",
        ),
    )

    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 200
    assert response.json()["provider"] == "groq"
    assert response.json()["model"] == "openai/gpt-oss-120b"
    usage = db.scalar(select(APIUsage))
    assert usage is not None
    assert usage.provider == "groq"
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


def test_demo_chat_releases_quota_when_all_providers_fail(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 20)

    def fail(*args, **kwargs):
        raise HTTPException(status_code=503, detail="provider unavailable")

    monkeypatch.setattr(demo_chat.groq_service, "complete", fail)
    response = client.post("/api/v1/demo/chat", json=payload())

    assert response.status_code == 503
    assert response.json()["detail"] == "The AI demo could not answer right now. Please try again."
    assert db.get(DemoChatSession, "demo-session-0001").messages_used == 0
    db.close()


def test_demo_chat_config_exposes_active_bedrock_model(monkeypatch) -> None:
    client, db = demo_client()
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_ENABLED", True)
    monkeypatch.setattr(settings, "PUBLIC_DEMO_CHAT_LIMIT", 20)
    response = client.get("/api/v1/demo/chat/config")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "provider": "bedrock",
        "model": settings.bedrock_model,
        "limit": 5,
    }
    db.close()
