from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.call import BlockedUser, Call, UserCallSettings
from app.models.social import SocialFollow, SocialNotification
from app.models.user import User
from app.models.user_chat import ChatMessage
from app.services import call_service as call_service_module
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
    assert requested.follow_status == "pending"
    incoming, _ = social_service.requests(db, user_b, "incoming", 1, 10)
    assert incoming[0].user.id == user_a.id

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
