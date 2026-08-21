from __future__ import annotations

import logging

from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from app.models.chat import Chat
from app.models.chat_message import ChatMessage
from app.models.chat_session import ChatSession
from app.models.message import Message


logger = logging.getLogger("auto_ai.chat_storage")


def model_from_metadata(message: Message, fallback: str | None = None) -> str | None:
    metadata = message.message_metadata or {}
    model_payload = metadata.get("model")
    if isinstance(model_payload, dict):
        model = model_payload.get("model")
        if isinstance(model, str) and model:
            return model
    return message.model or fallback


def sync_chat_session(db: Session, chat: Chat) -> None:
    """Best-effort sync to the legacy chat_sessions table.

    The primary chats table is authoritative. A stale/missing secondary table
    must never turn a successful chat create/update into HTTP 500.
    """
    try:
        with db.begin_nested():
            db.merge(
                ChatSession(
                    id=chat.id,
                    user_id=chat.user_id,
                    title=chat.title,
                    model=chat.model,
                    mode=chat.mode or "normal",
                    created_at=chat.created_at,
                    updated_at=chat.updated_at,
                )
            )
            db.flush()
    except Exception as exc:
        logger.warning("chat_session_sync_skipped error_type=%s", type(exc).__name__)


def sync_chat_message(db: Session, message: Message, *, user_id: str | None = None, model: str | None = None) -> None:
    resolved_user_id = message.user_id or user_id
    if not resolved_user_id:
        chat = db.get(Chat, message.chat_id)
        resolved_user_id = chat.user_id if chat else None
        model = model or (chat.model if chat else None)
    if not resolved_user_id:
        return

    try:
        with db.begin_nested():
            db.merge(
                ChatMessage(
                    id=message.id,
                    session_id=message.chat_id,
                    user_id=resolved_user_id,
                    role=message.role,
                    content=message.content,
                    model=model_from_metadata(message, model),
                    token_count=message.token_count or 0,
                    created_at=message.created_at,
                )
            )
            db.flush()
    except Exception as exc:
        logger.warning("chat_message_sync_skipped error_type=%s", type(exc).__name__)


def sync_chat_history(db: Session, chat: Chat) -> None:
    sync_chat_session(db, chat)
    for message in chat.messages or []:
        sync_chat_message(db, message, user_id=chat.user_id, model=chat.model)


def delete_chat_storage(db: Session, chat_id: str) -> None:
    try:
        db.execute(delete(ChatMessage).where(ChatMessage.session_id == chat_id))
        db.execute(delete(ChatSession).where(ChatSession.id == chat_id))
    except Exception as exc:
        logger.warning("chat_storage_delete_skipped error_type=%s", type(exc).__name__)


def clear_chat_message_storage(db: Session, chat_id: str) -> None:
    try:
        db.execute(delete(ChatMessage).where(ChatMessage.session_id == chat_id))
    except Exception as exc:
        logger.warning("chat_message_storage_clear_skipped error_type=%s", type(exc).__name__)


def backfill_chat_storage_tables(connection, quote) -> None:
    connection.execute(
        text(
            f"INSERT INTO {quote('chat_sessions')} "
            f"({quote('id')}, {quote('user_id')}, {quote('title')}, {quote('model')}, {quote('mode')}, {quote('created_at')}, {quote('updated_at')}) "
            f"SELECT {quote('id')}, {quote('user_id')}, {quote('title')}, {quote('model')}, COALESCE({quote('mode')}, 'normal'), {quote('created_at')}, {quote('updated_at')} "
            f"FROM {quote('chats')} c "
            f"WHERE NOT EXISTS (SELECT 1 FROM {quote('chat_sessions')} s WHERE s.{quote('id')} = c.{quote('id')})"
        )
    )
    connection.execute(
        text(
            f"INSERT INTO {quote('chat_messages')} "
            f"({quote('id')}, {quote('session_id')}, {quote('user_id')}, {quote('role')}, {quote('content')}, {quote('model')}, {quote('token_count')}, {quote('created_at')}) "
            f"SELECT m.{quote('id')}, m.{quote('chat_id')}, COALESCE(m.{quote('user_id')}, c.{quote('user_id')}), "
            f"m.{quote('role')}, m.{quote('content')}, COALESCE(m.{quote('model')}, c.{quote('model')}), "
            f"m.{quote('token_count')}, m.{quote('created_at')} "
            f"FROM {quote('messages')} m LEFT JOIN {quote('chats')} c ON c.{quote('id')} = m.{quote('chat_id')} "
            f"WHERE COALESCE(m.{quote('user_id')}, c.{quote('user_id')}) IS NOT NULL "
            f"AND NOT EXISTS (SELECT 1 FROM {quote('chat_messages')} cm WHERE cm.{quote('id')} = m.{quote('id')})"
        )
    )
