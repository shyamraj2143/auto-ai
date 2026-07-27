from datetime import UTC, datetime, timedelta, timezone

from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.chat_message import ChatMessage
from app.models.chat_session import ChatSession
from app.models.message import Message
from app.schemas.chat import ChatGenerationRead, ChatListItem, MessageRead
from app.utils.datetime import ensure_utc, to_rfc3339_utc, utc_now


def test_utc_now_is_timezone_aware_utc():
    assert utc_now().tzinfo is UTC


def test_legacy_naive_timestamp_serializes_as_utc():
    assert to_rfc3339_utc(datetime(2026, 7, 27, 9)) == "2026-07-27T09:00:00Z"


def test_aware_timestamp_is_normalized_without_shifting_utc_instant():
    source = datetime(2026, 7, 27, 14, 30, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    assert ensure_utc(source) == datetime(2026, 7, 27, 9, tzinfo=UTC)
    assert to_rfc3339_utc(datetime(2026, 7, 27, 9, tzinfo=UTC)) == "2026-07-27T09:00:00Z"


def test_chat_api_schemas_always_emit_explicit_utc():
    message = MessageRead(id="m", role="user", content="hello", created_at=datetime(2026, 7, 27, 9))
    chat = ChatListItem(id="c", title="Chat", model="model", created_at=datetime(2026, 7, 27, 9), updated_at=datetime(2026, 7, 27, 10, tzinfo=UTC))
    generation = ChatGenerationRead(id="g", chat_id="c", status="completed", created_at=datetime(2026, 7, 27, 9), updated_at=datetime(2026, 7, 27, 10), completed_at=datetime(2026, 7, 27, 11))
    assert message.model_dump(mode="json")["created_at"].endswith("Z")
    assert chat.model_dump(mode="json")["created_at"].endswith("Z")
    assert chat.model_dump(mode="json")["updated_at"].endswith("Z")
    assert generation.model_dump(mode="json")["completed_at"].endswith("Z")


def test_all_ai_chat_model_defaults_are_aware_utc_factories():
    for model, field in ((Chat, "created_at"), (Message, "created_at"), (ChatSession, "created_at"),
                         (ChatSession, "updated_at"), (ChatMessage, "created_at"),
                         (ChatGeneration, "created_at"), (ChatGeneration, "updated_at")):
        value = model.__table__.c[field].default.arg(None)
        assert value.utcoffset() == timedelta(0)
