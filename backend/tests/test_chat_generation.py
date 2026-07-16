import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.api.routes.ai import create_chat_generation
from app.db.base import Base
from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.message import Message
from app.models.user import User
from app.schemas.chat import ChatRequest


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def test_chat_generation_reuses_running_generation_for_duplicate_client_id(db, monkeypatch):
    monkeypatch.setattr("app.api.routes.ai.enforce_plan_and_feature_access", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.api.routes.ai.submit_chat_generation", lambda generation_id: None)
    user = User(
        id="chat-user",
        email="chat-user@example.test",
        name="Chat User",
        username="chat-user",
        hashed_password="unused",
        is_active=True,
    )
    chat = Chat(user_id=user.id, title="New chat", model="llama-3.1-8b-instant", mode="normal")
    db.add_all([user, chat])
    db.commit()

    payload = ChatRequest(message="Hi", chat_id=chat.id, client_message_id="client-1")
    first = create_chat_generation(payload, user, db)
    second = create_chat_generation(payload, user, db)

    messages = db.scalars(select(Message).where(Message.chat_id == chat.id)).all()
    generations = db.scalars(select(ChatGeneration).where(ChatGeneration.chat_id == chat.id)).all()

    assert first["id"] == second["id"]
    assert len([message for message in messages if message.role == "user"]) == 1
    assert len([message for message in messages if message.role == "assistant"]) == 1
    assert len(generations) == 1


def test_chat_generation_reuses_completed_generation_for_duplicate_client_id(db, monkeypatch):
    monkeypatch.setattr("app.api.routes.ai.enforce_plan_and_feature_access", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.api.routes.ai.submit_chat_generation", lambda generation_id: None)
    user = User(
        id="chat-user-completed",
        email="chat-user-completed@example.test",
        name="Chat User",
        username="chat-user-completed",
        hashed_password="unused",
        is_active=True,
    )
    chat = Chat(user_id=user.id, title="New chat", model="llama-3.1-8b-instant", mode="normal")
    db.add_all([user, chat])
    db.commit()

    payload = ChatRequest(message="Hi", chat_id=chat.id, client_message_id="client-completed")
    first = create_chat_generation(payload, user, db)
    generation = db.get(ChatGeneration, first["id"])
    generation.status = "completed"
    db.commit()

    second = create_chat_generation(payload, user, db)

    assert first["id"] == second["id"]
    assert db.scalar(select(func.count()).select_from(Message).where(Message.chat_id == chat.id, Message.role == "user")) == 1
    assert db.scalar(select(func.count()).select_from(Message).where(Message.chat_id == chat.id, Message.role == "assistant")) == 1
    assert db.scalar(select(func.count()).select_from(ChatGeneration).where(ChatGeneration.chat_id == chat.id)) == 1
