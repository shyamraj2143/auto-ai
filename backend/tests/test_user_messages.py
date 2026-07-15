from unittest.mock import AsyncMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.call import BlockedUser, UserCallSettings
from app.models.user import User
from app.models.user_chat import ChatMessage
from app.services import user_chat_service as service_module
from app.services.presence_service import presence_service as global_presence_service
from app.services.user_chat_service import user_chat_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def create_user(db: Session, user_id: str, name: str) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name=name,
        username=user_id,
        hashed_password="unused",
        is_active=True,
    )
    db.add(user)
    db.add(UserCallSettings(user_id=user_id, is_discoverable=True, call_permission="everyone"))
    db.commit()
    return user


@pytest.mark.asyncio
async def test_user_search_is_public_and_privacy_aware(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    viewer = create_user(db, "viewer-user", "Viewer")
    peer = create_user(db, "hava-user", "Hava")
    blocked = create_user(db, "blocked-user", "Blocked")
    db.add(BlockedUser(blocker_id=blocked.id, blocked_user_id=viewer.id))
    db.commit()
    monkeypatch.setattr(global_presence_service, "presence_for_user", AsyncMock(return_value={"state": "online", "last_seen_at": None, "reachable": True}))

    results, has_more = await user_chat_service.search_users(db, viewer, "ha", 1, 10)

    assert has_more is False
    assert [item.id for item in results] == [peer.id]
    assert results[0].display_name == "Hava"
    assert not hasattr(results[0], "email")


@pytest.mark.asyncio
async def test_send_message_dedupes_and_read_resets_unread(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    sender = create_user(db, "sender-user", "Sender")
    recipient = create_user(db, "recipient-user", "Recipient")
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(global_presence_service, "presence_for_user", AsyncMock(return_value={"state": "online", "last_seen_at": None, "reachable": True}))

    thread = user_chat_service.create_or_get_thread(db, sender, recipient.id)
    first = await user_chat_service.send_message(db, thread.id, sender, {"text_content": "hello", "client_message_id": "client-1"})
    duplicate = await user_chat_service.send_message(db, thread.id, sender, {"text_content": "hello again", "client_message_id": "client-1"})
    recipient_threads, _ = await user_chat_service.list_threads(db, recipient.id, 1, 10)

    assert first.id == duplicate.id
    assert db.query(ChatMessage).count() == 1
    assert recipient_threads[0].unread_count == 1

    await user_chat_service.mark_read(db, thread.id, recipient.id)
    recipient_threads, _ = await user_chat_service.list_threads(db, recipient.id, 1, 10)
    sender_view = user_chat_service.serialize_message(db, first, sender.id)

    assert recipient_threads[0].unread_count == 0
    assert sender_view.status == "read"


@pytest.mark.asyncio
async def test_pending_messages_are_delivered_when_recipient_reconnects(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    sender = create_user(db, "sender-user", "Sender")
    recipient = create_user(db, "recipient-user", "Recipient")
    publish = AsyncMock(return_value=0)
    monkeypatch.setattr(global_presence_service, "publish", publish)
    monkeypatch.setattr(service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(global_presence_service, "presence_for_user", AsyncMock(return_value={"state": "offline", "last_seen_at": None, "reachable": False}))

    thread = user_chat_service.create_or_get_thread(db, sender, recipient.id)
    message = await user_chat_service.send_message(db, thread.id, sender, {"text_content": "offline hello", "client_message_id": "client-offline"})

    assert user_chat_service.serialize_message(db, message, sender.id).status == "sent"

    publish.reset_mock()
    delivered = await user_chat_service.mark_pending_delivered_for_user(db, recipient.id)

    assert delivered == 1
    assert user_chat_service.serialize_message(db, message, sender.id).status == "delivered"
    assert publish.await_count >= 2


@pytest.mark.asyncio
async def test_sender_can_delete_own_message_and_thread_preview_updates(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    sender = create_user(db, "sender-user", "Sender")
    recipient = create_user(db, "recipient-user", "Recipient")
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(global_presence_service, "presence_for_user", AsyncMock(return_value={"state": "online", "last_seen_at": None, "reachable": True}))

    thread = user_chat_service.create_or_get_thread(db, sender, recipient.id)
    first = await user_chat_service.send_message(db, thread.id, sender, {"text_content": "first", "client_message_id": "client-first"})
    second = await user_chat_service.send_message(db, thread.id, sender, {"text_content": "second", "client_message_id": "client-second"})

    await user_chat_service.delete_message(db, thread.id, second.id, sender.id)

    messages, _ = user_chat_service.list_messages(db, thread.id, sender.id, None, 10)
    recipient_threads, _ = await user_chat_service.list_threads(db, recipient.id, 1, 10)

    assert [message.id for message in messages] == [first.id]
    assert db.get(ChatMessage, second.id).deleted_at is not None
    assert recipient_threads[0].last_message.id == first.id

    with pytest.raises(Exception):
        await user_chat_service.delete_message(db, thread.id, first.id, recipient.id)


def test_blocked_user_cannot_start_thread(db: Session) -> None:
    sender = create_user(db, "sender-user", "Sender")
    recipient = create_user(db, "recipient-user", "Recipient")
    db.add(BlockedUser(blocker_id=recipient.id, blocked_user_id=sender.id))
    db.commit()

    with pytest.raises(Exception):
        user_chat_service.create_or_get_thread(db, sender, recipient.id)
