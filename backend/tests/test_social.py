from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.call import BlockedUser, Call, UserCallSettings
from app.models.social import SearchHistory, SocialFollow, SocialNotification
from app.models.user import User
from app.models.user_chat import ChatMessage
from app.services import call_service as call_service_module
from app.services import social_service as social_service_module
from app.services import user_chat_service as chat_service_module
from app.services.call_permission_service import call_allowed
from app.services.call_service import call_service
from app.services.social_service import social_service
from app.services.user_chat_service import user_chat_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def create_user(db: Session, user_id: str, name: str, *, private: bool = False) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name=name,
        username=user_id,
        hashed_password="unused",
        is_active=True,
        profile_visibility="private" if private else "public",
        message_permission="followers",
    )
    db.add(user)
    db.add(UserCallSettings(user_id=user_id, is_discoverable=True, call_permission="followers"))
    db.commit()
    return user


@pytest.mark.asyncio
async def test_private_follow_request_unlocks_message_audio_and_video(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "private-user-b", "User B", private=True)
    monkeypatch.setattr(chat_service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(user_chat_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(call_service_module.presence_service, "allow_rate", AsyncMock(return_value=True))
    monkeypatch.setattr(call_service_module.presence_service, "acquire_call_locks", AsyncMock(return_value=True))
    monkeypatch.setattr(call_service_module.presence_service, "publish", AsyncMock(return_value=1))

    search_results, _ = social_service.search_users(db, user_a, "private", 1, 10)
    assert search_results[0].id == user_b.id
    assert search_results[0].profile_restricted is True
    assert social_service.can_message(db, user_a.id, user_b.id) is False
    assert call_allowed(db, user_a.id, user_b.id, "audio")[0] is False

    requested = social_service.follow_or_request(db, user_a, user_b.id)
    assert requested.follow_status == "pending_sent"
    incoming, _ = social_service.requests(db, user_b, "incoming", 1, 10)
    assert incoming[0].user.id == user_a.id
    assert incoming[0].user.follow_status == "pending_received"

    social_service.accept_request(db, user_b, incoming[0].id)
    assert db.query(SocialFollow).filter_by(follower_id=user_a.id, following_id=user_b.id, status="accepted").count() == 1
    profile = social_service.get_profile(db, user_a, user_b.id)
    assert profile.follow_status == "following"
    assert profile.can_message is True
    assert profile.can_audio_call is True
    assert profile.can_video_call is True

    thread = user_chat_service.create_or_get_thread(db, user_a, user_b.id)
    message = await user_chat_service.send_message(db, thread.id, user_a, {"text_content": "hello", "client_message_id": "social-1"})
    assert db.get(ChatMessage, message.id)
    assert db.query(SocialNotification).filter_by(user_id=user_b.id, notification_type="message").count() == 1

    audio = await call_service.initiate(db, user_a, user_b.id, "audio", None)
    video = await call_service.initiate(db, user_a, user_b.id, "video", None)
    assert audio.call_type == "audio"
    assert video.call_type == "video"
    assert db.query(Call).count() == 2


def test_user_cannot_follow_self(db: Session) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    with pytest.raises(HTTPException):
        social_service.follow_or_request(db, user_a, user_a.id)


def test_search_history_is_private_limited_and_clearable(db: Session) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    for index in range(22):
        social_service.add_search_history(db, user_a, f"query {index}", user_b.id if index == 21 else None)
    social_service.add_search_history(db, user_b, "private query", None)
    history = social_service.search_history(db, user_a)
    assert len(history) == 20
    assert history[0].selected_user_id == user_b.id
    assert all(item.query != "private query" for item in history)
    social_service.delete_search_history(db, user_a)
    assert db.query(SearchHistory).filter_by(user_id=user_a.id).count() == 0
    assert db.query(SearchHistory).filter_by(user_id=user_b.id).count() == 1


def test_clear_notifications_preserves_relationship(db: Session) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    social_service.follow_or_request(db, user_a, user_b.id)
    assert db.query(SocialNotification).filter_by(user_id=user_b.id).count() == 1
    social_service.delete_notification(db, user_b)
    assert db.query(SocialNotification).filter_by(user_id=user_b.id).count() == 0
    assert db.query(SocialFollow).filter_by(follower_id=user_a.id, following_id=user_b.id).count() == 1


def test_duplicate_and_reverse_requests_do_not_create_duplicate_relationships(db: Session) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")

    first = social_service.follow_or_request(db, user_a, user_b.id)
    second = social_service.follow_or_request(db, user_a, user_b.id)
    reverse = social_service.follow_or_request(db, user_b, user_a.id)

    assert first.request_id == second.request_id == reverse.request_id
    assert second.follow_status == "pending_sent"
    assert reverse.follow_status == "pending_received"
    assert db.query(SocialFollow).count() == 1


def test_accept_is_idempotent_and_preserves_server_timestamp(db: Session) -> None:
    user_a = create_user(db, "accept-user-a", "User A")
    user_b = create_user(db, "accept-user-b", "User B")
    requested = social_service.follow_or_request(db, user_a, user_b.id)
    assert requested.request_id

    first = social_service.accept_request(db, user_b, requested.request_id)
    record = db.get(SocialFollow, requested.request_id)
    accepted_at = record.responded_at
    second = social_service.accept_request(db, user_b, requested.request_id)

    assert first.id == second.id == user_a.id
    assert record.status == "accepted"
    assert record.responded_at == accepted_at
    assert db.query(SocialFollow).count() == 1


def test_follow_succeeds_when_push_delivery_fails(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "push-follow-a", "User A")
    user_b = create_user(db, "push-follow-b", "User B")
    monkeypatch.setattr(social_service_module, "send_social_push_notification", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("FCM unavailable")))

    profile = social_service.follow_or_request(db, user_a, user_b.id)

    assert profile.follow_status == "pending_sent"
    assert db.query(SocialFollow).filter_by(follower_id=user_a.id, following_id=user_b.id, status="pending").count() == 1


def test_accept_succeeds_when_push_fails_and_reuses_existing_chat(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "push-accept-a", "User A")
    user_b = create_user(db, "push-accept-b", "User B")
    request = social_service.follow_or_request(db, user_a, user_b.id)
    monkeypatch.setattr(social_service_module, "send_social_push_notification", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("FCM unavailable")))

    social_service.accept_request(db, user_b, request.request_id or "")
    first_thread = user_chat_service.create_or_get_thread(db, user_b, user_a.id)
    social_service.accept_request(db, user_b, request.request_id or "")
    second_thread = user_chat_service.create_or_get_thread(db, user_b, user_a.id)

    assert db.get(SocialFollow, request.request_id).status == "accepted"
    assert first_thread.id == second_thread.id


def test_only_receiver_can_accept_or_reject_and_sender_can_cancel(db: Session) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    user_c = create_user(db, "public-user-c", "User C")

    request_profile = social_service.follow_or_request(db, user_a, user_b.id)
    assert request_profile.request_id

    with pytest.raises(HTTPException):
        social_service.accept_request(db, user_c, request_profile.request_id)
    with pytest.raises(HTTPException):
        social_service.reject_request(db, user_c, request_profile.request_id)

    cancelled = social_service.cancel_request(db, user_a, user_b.id)
    assert cancelled.follow_status == "cancelled"


@pytest.mark.asyncio
async def test_chat_search_and_list_follow_connection_rules(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    user_c = create_user(db, "public-user-c", "User C")
    monkeypatch.setattr(chat_service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(user_chat_service, "publish", AsyncMock(return_value=1))

    social_service.follow_or_request(db, user_a, user_b.id)
    pending_results, _ = await user_chat_service.search_users(db, user_a, "user", 1, 10)
    assert user_b.id not in {item.id for item in pending_results}

    request = db.query(SocialFollow).filter_by(follower_id=user_a.id, following_id=user_b.id).one()
    social_service.accept_request(db, user_b, request.id)
    accepted_results, _ = await user_chat_service.search_users(db, user_a, "user", 1, 10)
    assert user_b.id in {item.id for item in accepted_results}
    assert user_c.id not in {item.id for item in accepted_results}

    thread = user_chat_service.create_or_get_thread(db, user_a, user_b.id)
    empty_threads, _ = await user_chat_service.list_threads(db, user_a.id, 1, 10)
    assert empty_threads == []

    await user_chat_service.send_message(db, thread.id, user_a, {"text_content": "hello", "client_message_id": "first-message"})
    visible_threads, _ = await user_chat_service.list_threads(db, user_a.id, 1, 10)
    assert [item.id for item in visible_threads] == [thread.id]

    with pytest.raises(HTTPException):
        user_chat_service.create_or_get_thread(db, user_a, user_c.id)


@pytest.mark.asyncio
async def test_unaccepted_user_cannot_call(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    monkeypatch.setattr(call_service_module.presence_service, "allow_rate", AsyncMock(return_value=True))

    with pytest.raises(HTTPException):
        await call_service.initiate(db, user_a, user_b.id, "audio", None)


@pytest.mark.asyncio
async def test_disconnect_preserves_message_history_and_disables_new_messages(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "public-user-b", "User B")
    monkeypatch.setattr(chat_service_module, "send_chat_message_notifications", lambda *args, **kwargs: 0)
    monkeypatch.setattr(user_chat_service, "publish", AsyncMock(return_value=1))

    social_service.follow_or_request(db, user_a, user_b.id)
    request = db.query(SocialFollow).filter_by(follower_id=user_a.id, following_id=user_b.id).one()
    social_service.accept_request(db, user_b, request.id)
    thread = user_chat_service.create_or_get_thread(db, user_a, user_b.id)
    await user_chat_service.send_message(db, thread.id, user_a, {"text_content": "saved", "client_message_id": "kept"})

    social_service.unfollow(db, user_a, user_b.id)
    messages, _ = user_chat_service.list_messages(db, thread.id, user_a.id, None, 20)
    assert messages[0].text_content == "saved"
    serialized = await user_chat_service.serialize_thread(db, thread, user_a.id)
    assert serialized.restricted_reason == "Connection ended"
    with pytest.raises(HTTPException):
        await user_chat_service.send_message(db, thread.id, user_a, {"text_content": "blocked"})


@pytest.mark.asyncio
async def test_block_prevents_search_messages_and_calls(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user_a = create_user(db, "public-user-a", "User A")
    user_b = create_user(db, "private-user-b", "User B", private=True)
    monkeypatch.setattr(call_service_module.presence_service, "allow_rate", AsyncMock(return_value=True))
    db.add(SocialFollow(follower_id=user_a.id, following_id=user_b.id, status="accepted"))
    db.add(BlockedUser(blocker_id=user_b.id, blocked_user_id=user_a.id))
    db.commit()

    search_results, _ = social_service.search_users(db, user_a, "private", 1, 10)
    assert search_results == []
    assert social_service.can_message(db, user_a.id, user_b.id) is False

    with pytest.raises(HTTPException):
        user_chat_service.create_or_get_thread(db, user_a, user_b.id)
    with pytest.raises(HTTPException):
        await call_service.initiate(db, user_a, user_b.id, "audio", None)
