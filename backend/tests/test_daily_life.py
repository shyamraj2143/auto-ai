import hashlib
import hmac
import json
import time
from datetime import timedelta

import pytest
from fastapi import HTTPException
from pydantic import SecretStr
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.routes.payments import verify_stripe_webhook
from app.api.routes.user_data import export_chat_backup, restore_chat_backup, user_usage
from app.core.config import settings
from app.db.base import Base
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.message import Message
from app.models.user import User
from app.schemas.user_data import ChatBackup, RestoreRequest
from app.services.response_cache import ResponseCache
from app.utils.datetime import utc_now


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False) as session:
        yield session


def add_user(db: Session, user_id: str) -> User:
    user = User(id=user_id, email=f"{user_id}@example.test", name=user_id, username=user_id, hashed_password="unused", is_active=True)
    db.add(user)
    db.commit()
    return user


def test_chat_backup_is_owned_versioned_and_merge_is_idempotent(db: Session) -> None:
    owner = add_user(db, "backup-owner")
    other = add_user(db, "backup-other")
    chat = Chat(id="owner-chat", user_id=owner.id, title="Owned", model="model-a", mode="normal")
    db.add_all([chat, Chat(id="other-chat", user_id=other.id, title="Other", model="model-b", mode="normal")])
    db.flush()
    db.add_all([
        Message(id="owner-message", chat_id=chat.id, user_id=owner.id, role="user", content="private owner text", model="model-a"),
        Message(id="other-message", chat_id="other-chat", user_id=other.id, role="user", content="private other text", model="model-b"),
    ])
    db.commit()

    response = export_chat_backup(owner, db)
    body = json.loads(response.body)
    assert body["schema"] == "autoai.chat-backup" and body["schema_version"] == 1
    serialized = json.dumps(body)
    assert "private owner text" in serialized and "private other text" not in serialized
    backup = ChatBackup.model_validate(body)
    result = restore_chat_backup(RestoreRequest(backup=backup, mode="merge"), owner, db)
    assert result.chats_imported == 0 and result.chats_skipped == 1


def test_replace_restore_requires_confirmation_and_is_transactional(db: Session) -> None:
    owner = add_user(db, "replace-owner")
    now = utc_now()
    backup = ChatBackup.model_validate({"schema": "autoai.chat-backup", "schema_version": 1, "exported_at": now, "chats": [{"id": "restored-chat", "title": "Restored", "model": "model-a", "mode": "normal", "created_at": now, "updated_at": now, "messages": [{"id": "restored-message", "role": "assistant", "content": "restored", "model": "model-a", "token_count": 2, "created_at": now}]}]})
    with pytest.raises(HTTPException) as error:
        restore_chat_backup(RestoreRequest(backup=backup, mode="replace", confirm_replace=False), owner, db)
    assert error.value.status_code == 409
    result = restore_chat_backup(RestoreRequest(backup=backup, mode="replace", confirm_replace=True), owner, db)
    assert result.chats_imported == 1 and result.messages_imported == 1
    assert db.scalar(select(Chat).where(Chat.id == "restored-chat", Chat.user_id == owner.id))


def test_user_usage_is_scoped_and_reports_real_cache_metrics(db: Session) -> None:
    owner = add_user(db, "usage-owner")
    other = add_user(db, "usage-other")
    now = utc_now()
    db.add_all([
        APIUsage(user_id=owner.id, provider="groq", model="m1", endpoint="chat", input_tokens=10, output_tokens=5, total_tokens=15, latency_ms=120, cache_status="miss", created_at=now),
        APIUsage(user_id=owner.id, provider="groq", model="m1", endpoint="chat", input_tokens=10, output_tokens=5, total_tokens=15, latency_ms=0, cache_status="hit", created_at=now),
        APIUsage(user_id=other.id, provider="openai", model="secret", endpoint="chat", total_tokens=999, created_at=now),
    ])
    db.commit()
    result = user_usage(days=7, start=now - timedelta(days=1), end=now + timedelta(days=1), current_user=owner, db=db)
    assert result.requests == 2 and result.total_tokens == 30
    assert result.cache_hits == 1 and result.cache_misses == 1
    assert all(item.model != "secret" for item in result.dimensions)


def test_response_cache_key_is_user_isolated() -> None:
    messages = [{"role": "user", "content": "same prompt"}]
    first = ResponseCache.key(user_id="user-a", provider="groq", model="m", messages=messages, settings_payload={})
    second = ResponseCache.key(user_id="user-b", provider="groq", model="m", messages=messages, settings_payload={})
    assert first != second


def test_stripe_webhook_signature_and_expiry(monkeypatch) -> None:
    secret = "whsec_test_secret"
    monkeypatch.setattr(settings, "STRIPE_WEBHOOK_SECRET", SecretStr(secret))
    payload = b'{"id":"evt_1"}'
    timestamp = int(time.time())
    digest = hmac.new(secret.encode(), str(timestamp).encode() + b"." + payload, hashlib.sha256).hexdigest()
    verify_stripe_webhook(payload, f"t={timestamp},v1={digest}")
    with pytest.raises(HTTPException):
        verify_stripe_webhook(payload, f"t={timestamp - 301},v1={digest}")
