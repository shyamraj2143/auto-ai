import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.base import Base
from app.models.chat import Chat
from app.models.human import UserMemory
from app.models.message import Message
from app.models.message_feedback import MessageFeedback
from app.models.user import User
from app.schemas.feedback import MessageFeedbackWrite
from app.services.feedback_service import message_feedback_service
from app.services.human.memory_service import long_term_memory_engine
from app.services.human.metacognition import meta_cognition_layer


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def add_user_chat(db: Session, suffix: str) -> tuple[User, Chat, Message, Message]:
    user = User(
        id=f"user-{suffix}",
        email=f"{suffix}@example.test",
        name=suffix,
        username=f"user_{suffix}",
        hashed_password="unused",
        is_active=True,
    )
    chat = Chat(id=f"chat-{suffix}", user_id=user.id, title="Feedback", model="model-a", mode="instant")
    user_message = Message(
        id=f"user-message-{suffix}", chat_id=chat.id, user_id=user.id, role="user", content="private prompt"
    )
    assistant = Message(
        id=f"assistant-{suffix}",
        chat_id=chat.id,
        user_id=user.id,
        role="assistant",
        content="private answer",
        model="model-a",
        message_metadata={"model": {"provider": "groq", "model": "model-a"}},
    )
    db.add_all([user, chat, user_message, assistant])
    db.commit()
    return user, chat, user_message, assistant


def test_owner_can_rate_assistant_and_duplicate_updates_existing(db: Session) -> None:
    user, chat, _user_message, assistant = add_user_chat(db, "owner")
    first = message_feedback_service.put(
        db, user=user, chat_id=chat.id, message_id=assistant.id, rating=1, reason=None, comment=None
    )
    second = message_feedback_service.put(
        db,
        user=user,
        chat_id=chat.id,
        message_id=assistant.id,
        rating=-1,
        reason="incorrect",
        comment="Wrong version",
    )
    assert first.id == second.id
    assert second.rating == -1
    assert second.reason == "incorrect"
    assert db.scalar(select(func.count()).select_from(MessageFeedback)) == 1


def test_user_cannot_rate_another_users_message(db: Session) -> None:
    owner, chat, _user_message, assistant = add_user_chat(db, "owner2")
    outsider, _other_chat, _other_user_message, _other_assistant = add_user_chat(db, "outsider")
    with pytest.raises(HTTPException) as exc:
        message_feedback_service.put(
            db, user=outsider, chat_id=chat.id, message_id=assistant.id, rating=1, reason=None, comment=None
        )
    assert exc.value.status_code == 404
    assert owner.id != outsider.id


def test_user_authored_message_cannot_be_rated(db: Session) -> None:
    user, chat, user_message, _assistant = add_user_chat(db, "role")
    with pytest.raises(HTTPException) as exc:
        message_feedback_service.put(
            db, user=user, chat_id=chat.id, message_id=user_message.id, rating=1, reason=None, comment=None
        )
    assert exc.value.status_code == 422


def test_feedback_delete_and_read_are_user_scoped(db: Session) -> None:
    user, chat, _user_message, assistant = add_user_chat(db, "delete")
    message_feedback_service.put(
        db, user=user, chat_id=chat.id, message_id=assistant.id, rating=1, reason=None, comment=None
    )
    assert message_feedback_service.get(
        db, user_id=user.id, chat_id=chat.id, message_id=assistant.id
    ) is not None
    message_feedback_service.delete(
        db, user_id=user.id, chat_id=chat.id, message_id=assistant.id
    )
    assert message_feedback_service.get(
        db, user_id=user.id, chat_id=chat.id, message_id=assistant.id
    ) is None


def test_dislike_reason_and_comment_are_validated() -> None:
    assert MessageFeedbackWrite(rating=-1, reason="not_helpful", comment="  More   detail ").comment == "More detail"
    with pytest.raises(ValidationError):
        MessageFeedbackWrite(rating=-1, reason="unbounded")
    with pytest.raises(ValidationError):
        MessageFeedbackWrite(rating=1, reason="incorrect")
    with pytest.raises(ValidationError):
        MessageFeedbackWrite(rating=-1, reason="other", comment="x" * 501)


def test_memories_are_never_retrieved_across_accounts(db: Session) -> None:
    first, _chat, _message, _assistant = add_user_chat(db, "memory-a")
    second, _chat2, _message2, _assistant2 = add_user_chat(db, "memory-b")
    long_term_memory_engine.create_memory(
        db,
        user_id=first.id,
        payload={"category": "project", "key": "private_project", "value": "Build Atlas", "confidence": 0.9, "source": "user"},
    )
    assert long_term_memory_engine.retrieve_relevant_memories(
        db, user_id=second.id, query="Atlas"
    ) == []


@pytest.mark.parametrize(
    "text",
    [
        "Remember that my password is HunterExample123",
        "Remember that my API key is sk-example-secret-value-123456",
        "Remember that my card is 4111 1111 1111 1111",
        "Remember that my Aadhaar number is 1234 5678 9012",
    ],
)
def test_sensitive_values_are_rejected_from_memory_extraction(text: str) -> None:
    assert long_term_memory_engine.extract_candidates(text) == []


def test_disabling_memory_stops_new_long_term_memory_writes(db: Session) -> None:
    user, chat, user_message, assistant = add_user_chat(db, "paused")
    user.memory_enabled = False
    db.commit()
    prepared = meta_cognition_layer.prepare_context(
        db,
        user_id=user.id,
        chat_id=chat.id,
        user_message="Remember that I am building private Atlas",
        history=[],
    )
    meta_cognition_layer.complete_turn(
        db,
        user_id=user.id,
        chat_id=chat.id,
        user_message=user_message.content,
        prepared=prepared,
        user_message_id=user_message.id,
        assistant_message_id=assistant.id,
    )
    db.commit()
    assert prepared["memory_candidates"] == []
    assert db.scalars(select(UserMemory).where(UserMemory.user_id == user.id)).all() == []


def test_aggregate_feedback_has_no_raw_chat_or_user_identifiers(db: Session, monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEEDBACK_ANALYTICS_MIN_GROUP_SIZE", 2)
    for suffix, rating in (("aggregate-a", 1), ("aggregate-b", -1)):
        user, chat, _user_message, assistant = add_user_chat(db, suffix)
        message_feedback_service.put(
            db,
            user=user,
            chat_id=chat.id,
            message_id=assistant.id,
            rating=rating,
            reason="not_helpful" if rating == -1 else None,
            comment="raw private critique",
        )
    aggregate = message_feedback_service.aggregate(db)
    assert aggregate and aggregate[0]["total"] == 2
    serialized = str(aggregate)
    assert "private prompt" not in serialized
    assert "private answer" not in serialized
    assert "raw private critique" not in serialized
    assert "user-aggregate" not in serialized
