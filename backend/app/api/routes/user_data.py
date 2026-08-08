from __future__ import annotations

import json
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response
from sqlalchemy import case, delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.admin_control import AuditLog
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.chat_message import ChatMessage
from app.models.chat_session import ChatSession
from app.models.message import Message
from app.models.user import User
from app.schemas.user_data import (
    BackupChat,
    BackupMessage,
    BackupPreview,
    ChatBackup,
    RestoreRequest,
    RestoreResult,
    UsageBucket,
    UsageDimension,
    UserUsageResponse,
)
from app.services.chat_storage import sync_chat_history
from app.utils.datetime import utc_now


router = APIRouter(prefix="/user-data", tags=["user-data"])


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _preview(backup: ChatBackup) -> BackupPreview:
    return BackupPreview(
        valid=True,
        schema_version=backup.schema_version,
        backup_date=_aware(backup.exported_at),
        chat_count=len(backup.chats),
        message_count=sum(len(chat.messages) for chat in backup.chats),
    )


@router.get("/backup")
def export_chat_backup(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    chats = list(
        db.scalars(
            select(Chat)
            .where(Chat.user_id == current_user.id)
            .options(selectinload(Chat.messages))
            .order_by(Chat.created_at)
        ).unique()
    )
    backup = ChatBackup(
        schema_name="autoai.chat-backup",
        schema_version=1,
        exported_at=utc_now(),
        chats=[
            BackupChat(
                id=chat.id,
                title=chat.title,
                model=chat.model,
                mode=chat.mode or "normal",
                created_at=_aware(chat.created_at),
                updated_at=_aware(chat.updated_at),
                messages=[
                    BackupMessage(
                        id=message.id,
                        role=message.role,
                        content=message.content,
                        model=message.model,
                        token_count=max(0, message.token_count or 0),
                        created_at=_aware(message.created_at),
                    )
                    for message in chat.messages
                    if message.role in {"user", "assistant", "system"}
                ],
            )
            for chat in chats
        ],
    )
    db.add(AuditLog(actor_user_id=current_user.id, target_user_id=current_user.id, action="chat_backup_exported", reason="User exported owned chat history", audit_metadata={"chat_count": len(backup.chats), "message_count": sum(len(item.messages) for item in backup.chats), "schema_version": 1}))
    db.commit()
    stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
    return Response(
        content=json.dumps(backup.model_dump(mode="json", by_alias=True), ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="autoai-chat-backup-{stamp}.json"', "Cache-Control": "no-store"},
    )


@router.post("/restore/preview", response_model=BackupPreview)
def preview_chat_restore(payload: ChatBackup, _: User = Depends(get_current_user)) -> BackupPreview:
    return _preview(payload)


def _owned_or_remapped_id(db: Session, model: type[Chat] | type[Message], requested: str, user_id: str) -> str:
    existing = db.get(model, requested)
    if existing is None or getattr(existing, "user_id", None) == user_id:
        return requested
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"autoai:{user_id}:{model.__name__}:{requested}"))


@router.post("/restore", response_model=RestoreResult)
def restore_chat_backup(
    payload: RestoreRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> RestoreResult:
    if payload.mode == "replace" and not payload.confirm_replace:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Replace restore requires explicit confirmation.")

    imported_chats = skipped_chats = imported_messages = 0
    try:
        if payload.mode == "replace":
            owned_ids = list(db.scalars(select(Chat.id).where(Chat.user_id == current_user.id)))
            if owned_ids:
                db.execute(delete(ChatMessage).where(ChatMessage.user_id == current_user.id))
                db.execute(delete(ChatSession).where(ChatSession.user_id == current_user.id))
                db.execute(delete(Message).where(Message.chat_id.in_(owned_ids)))
                db.execute(delete(Chat).where(Chat.user_id == current_user.id))
                db.flush()

        for source_chat in payload.backup.chats:
            chat_id = _owned_or_remapped_id(db, Chat, source_chat.id, current_user.id)
            existing_chat = db.scalar(select(Chat).where(Chat.id == chat_id, Chat.user_id == current_user.id))
            if existing_chat:
                skipped_chats += 1
                continue
            chat = Chat(
                id=chat_id,
                user_id=current_user.id,
                title=source_chat.title,
                model=source_chat.model,
                mode=source_chat.mode,
                created_at=_aware(source_chat.created_at),
                updated_at=_aware(source_chat.updated_at),
            )
            db.add(chat)
            db.flush()
            imported_chats += 1
            for source_message in source_chat.messages:
                message_id = _owned_or_remapped_id(db, Message, source_message.id, current_user.id)
                if db.get(Message, message_id):
                    continue
                db.add(Message(
                    id=message_id,
                    chat_id=chat.id,
                    user_id=current_user.id,
                    role=source_message.role,
                    content=source_message.content,
                    model=source_message.model,
                    token_count=source_message.token_count,
                    message_metadata={"restored_from_backup": True, "schema_version": 1},
                    created_at=_aware(source_message.created_at),
                ))
                imported_messages += 1
            db.flush()
            db.refresh(chat)
            sync_chat_history(db, chat)

        db.add(AuditLog(actor_user_id=current_user.id, target_user_id=current_user.id, action="chat_backup_restored", reason=f"User completed {payload.mode} restore", audit_metadata={"schema_version": 1, "chats_imported": imported_chats, "chats_skipped": skipped_chats, "messages_imported": imported_messages}))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return RestoreResult(mode=payload.mode, chats_imported=imported_chats, chats_skipped=skipped_chats, messages_imported=imported_messages)


@router.get("/usage", response_model=UserUsageResponse)
def user_usage(
    days: int = Query(default=7, ge=1, le=366),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserUsageResponse:
    end_at = _aware(end) if end else utc_now()
    start_at = _aware(start) if start else end_at - timedelta(days=days)
    if start_at >= end_at or end_at - start_at > timedelta(days=366):
        raise HTTPException(status_code=422, detail="Usage range must be positive and no longer than 366 days.")
    rows = db.execute(
        select(
            APIUsage.provider,
            APIUsage.model,
            func.count(APIUsage.id),
            func.coalesce(func.sum(APIUsage.input_tokens), 0),
            func.coalesce(func.sum(APIUsage.output_tokens), 0),
            func.coalesce(func.sum(APIUsage.total_tokens), 0),
            func.coalesce(func.avg(APIUsage.latency_ms), 0),
            func.coalesce(func.sum(case((APIUsage.cache_status == "hit", 1), else_=0)), 0),
            func.coalesce(func.sum(case((APIUsage.cache_status == "miss", 1), else_=0)), 0),
            func.coalesce(func.sum(case((APIUsage.error_code.is_not(None), 1), else_=0)), 0),
        )
        .where(APIUsage.user_id == current_user.id, APIUsage.created_at >= start_at, APIUsage.created_at < end_at)
        .group_by(APIUsage.provider, APIUsage.model)
        .order_by(func.count(APIUsage.id).desc())
    ).all()
    daily_values: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for created_at, input_tokens, output_tokens, total_tokens in db.execute(
        select(APIUsage.created_at, APIUsage.input_tokens, APIUsage.output_tokens, APIUsage.total_tokens)
        .where(APIUsage.user_id == current_user.id, APIUsage.created_at >= start_at, APIUsage.created_at < end_at)
        .order_by(APIUsage.created_at)
    ):
        period = _aware(created_at).date().isoformat()
        values = daily_values[period]
        values[0] += 1
        values[1] += int(input_tokens or 0)
        values[2] += int(output_tokens or 0)
        values[3] += int(total_tokens or 0)
    dimensions = [UsageDimension(provider=str(provider), model=str(model), requests=int(requests), input_tokens=int(input_tokens), output_tokens=int(output_tokens), total_tokens=int(total_tokens), average_latency_ms=int(average_latency or 0), cache_hits=int(cache_hits or 0), cache_misses=int(cache_misses or 0), errors=int(errors or 0)) for provider, model, requests, input_tokens, output_tokens, total_tokens, average_latency, cache_hits, cache_misses, errors in rows]
    buckets = [UsageBucket(period=period, requests=values[0], input_tokens=values[1], output_tokens=values[2], total_tokens=values[3]) for period, values in sorted(daily_values.items())]
    return UserUsageResponse(
        start_at=start_at,
        end_at=end_at,
        requests=sum(item.requests for item in dimensions),
        input_tokens=sum(item.input_tokens for item in dimensions),
        output_tokens=sum(item.output_tokens for item in dimensions),
        total_tokens=sum(item.total_tokens for item in dimensions),
        average_latency_ms=int(sum(item.average_latency_ms * item.requests for item in dimensions) / max(sum(item.requests for item in dimensions), 1)),
        cache_hits=sum(item.cache_hits for item in dimensions),
        cache_misses=sum(item.cache_misses for item in dimensions),
        errors=sum(item.errors for item in dimensions),
        buckets=buckets,
        dimensions=dimensions,
    )
