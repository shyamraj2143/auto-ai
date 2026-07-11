from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.call import BlockedUser, UserCallSettings
from app.models.user import User
from app.models.user_chat import ChatMessage, ChatParticipant, ChatThread, MessageReceipt, UserChatSettings
from app.schemas.user_chat import ChatMessageRead, ChatPublicUser, ChatThreadRead
from app.services.call_permission_service import call_allowed, get_or_create_call_settings
from app.services.call_service import call_service
from app.services.chat_notification_service import send_chat_message_notifications
from app.services.presence_service import RealtimeUnavailable, presence_service


MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024
ALLOWED_CHAT_MIME_PREFIXES = ("image/", "application/pdf", "text/", "application/zip")


def utcnow() -> datetime:
    return datetime.utcnow()


def chat_event(event_type: str, sender_user_id: str, payload: dict[str, Any], thread_id: str | None = None) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "type": event_type,
        "thread_id": thread_id,
        "sender_user_id": sender_user_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


class UserChatService:
    def get_or_create_settings(self, db: Session, user_id: str) -> UserChatSettings:
        record = db.scalar(select(UserChatSettings).where(UserChatSettings.user_id == user_id))
        if record:
            return record
        record = UserChatSettings(user_id=user_id)
        db.add(record)
        db.flush()
        return record

    def blocked_between(self, db: Session, first_user_id: str, second_user_id: str) -> bool:
        return db.scalar(
            select(BlockedUser.id).where(
                or_(
                    and_(BlockedUser.blocker_id == first_user_id, BlockedUser.blocked_user_id == second_user_id),
                    and_(BlockedUser.blocker_id == second_user_id, BlockedUser.blocked_user_id == first_user_id),
                )
            )
        ) is not None

    def participant(self, db: Session, thread_id: str, user_id: str) -> ChatParticipant:
        participant = db.scalar(
            select(ChatParticipant).where(ChatParticipant.thread_id == thread_id, ChatParticipant.user_id == user_id)
        )
        if not participant:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat thread not found.")
        return participant

    def thread_participants(self, db: Session, thread_id: str) -> list[ChatParticipant]:
        return list(db.scalars(select(ChatParticipant).where(ChatParticipant.thread_id == thread_id)))

    def peer_id_for(self, db: Session, thread_id: str, user_id: str) -> str:
        peer_id = db.scalar(
            select(ChatParticipant.user_id).where(ChatParticipant.thread_id == thread_id, ChatParticipant.user_id != user_id)
        )
        if not peer_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat peer not found.")
        return str(peer_id)

    async def public_user(self, db: Session, user: User, viewer_id: str) -> ChatPublicUser:
        settings_record = get_or_create_call_settings(db, user.id)
        public = await call_service.public_user(db, user, viewer_id=viewer_id, settings_record=settings_record)
        chat_settings = self.get_or_create_settings(db, user.id)
        if not chat_settings.last_seen_enabled and viewer_id != user.id:
            public.last_seen_at = None
        public.can_audio_call = public.presence != "busy" and call_allowed(db, viewer_id, user.id, "audio")[0]
        public.can_video_call = public.presence != "busy" and call_allowed(db, viewer_id, user.id, "video")[0]
        return ChatPublicUser(
            id=public.id,
            display_name=public.display_name,
            username=public.username,
            avatar_url=public.avatar_url,
            presence=public.presence,
            availability=public.availability,
            can_audio_call=public.can_audio_call,
            can_video_call=public.can_video_call,
            last_seen_at=public.last_seen_at,
        )

    def can_message(self, db: Session, sender_id: str, recipient_id: str) -> bool:
        if sender_id == recipient_id or self.blocked_between(db, sender_id, recipient_id):
            return False
        recipient_settings = self.get_or_create_settings(db, recipient_id)
        if recipient_settings.allow_messages_from == "nobody":
            return False
        if recipient_settings.allow_messages_from == "known_users":
            return self.existing_private_thread_id(db, sender_id, recipient_id) is not None
        return True

    def existing_private_thread_id(self, db: Session, first_user_id: str, second_user_id: str) -> str | None:
        first_threads = select(ChatParticipant.thread_id).where(ChatParticipant.user_id == first_user_id).subquery()
        return db.scalar(
            select(ChatThread.id)
            .join(ChatParticipant, ChatParticipant.thread_id == ChatThread.id)
            .where(
                ChatThread.is_group == False,  # noqa: E712
                ChatParticipant.user_id == second_user_id,
                ChatThread.id.in_(select(first_threads.c.thread_id)),
            )
            .order_by(ChatThread.updated_at.desc())
            .limit(1)
        )

    def create_or_get_thread(self, db: Session, current_user: User, peer_user_id: str) -> ChatThread:
        peer = db.get(User, peer_user_id)
        if not peer or not peer.is_active:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        if not self.can_message(db, current_user.id, peer.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Messaging is not allowed with this user.")
        existing_id = self.existing_private_thread_id(db, current_user.id, peer.id)
        if existing_id:
            thread = db.get(ChatThread, existing_id)
            if thread:
                return thread
        thread = ChatThread(is_group=False)
        db.add(thread)
        db.flush()
        db.add_all([ChatParticipant(thread_id=thread.id, user_id=current_user.id), ChatParticipant(thread_id=thread.id, user_id=peer.id)])
        db.commit()
        db.refresh(thread)
        return thread

    def message_status(self, db: Session, message: ChatMessage, viewer_id: str) -> str:
        if message.sender_id != viewer_id:
            return "read"
        receipts = list(db.scalars(select(MessageReceipt).where(MessageReceipt.message_id == message.id, MessageReceipt.user_id != viewer_id)))
        if any(receipt.read_at for receipt in receipts):
            return "read"
        if any(receipt.delivered_at for receipt in receipts):
            return "delivered"
        return "sent"

    def serialize_message(self, db: Session, message: ChatMessage, viewer_id: str) -> ChatMessageRead:
        return ChatMessageRead(
            id=message.id,
            thread_id=message.thread_id,
            sender_id=message.sender_id,
            client_message_id=message.client_message_id,
            message_type=message.message_type,
            text_content=message.text_content,
            attachment_url=message.attachment_url,
            attachment_name=message.attachment_name,
            attachment_size=message.attachment_size,
            mime_type=message.mime_type,
            created_at=message.created_at,
            edited_at=message.edited_at,
            deleted_at=message.deleted_at,
            reply_to_message_id=message.reply_to_message_id,
            status=self.message_status(db, message, viewer_id),
        )

    async def serialize_thread(self, db: Session, thread: ChatThread, viewer_id: str) -> ChatThreadRead:
        participant = self.participant(db, thread.id, viewer_id)
        peer = db.get(User, self.peer_id_for(db, thread.id, viewer_id))
        if not peer:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat peer not found.")
        last_message = db.get(ChatMessage, thread.last_message_id) if thread.last_message_id else None
        last_read_at = participant.last_read_at or datetime.min
        unread_count = int(
            db.scalar(
                select(func.count(ChatMessage.id)).where(
                    ChatMessage.thread_id == thread.id,
                    ChatMessage.sender_id != viewer_id,
                    ChatMessage.created_at > last_read_at,
                    ChatMessage.deleted_at.is_(None),
                )
            )
            or 0
        )
        return ChatThreadRead(
            id=thread.id,
            is_group=thread.is_group,
            created_at=thread.created_at,
            updated_at=thread.updated_at,
            peer=await self.public_user(db, peer, viewer_id),
            last_message=self.serialize_message(db, last_message, viewer_id) if last_message else None,
            unread_count=unread_count,
            archived=participant.archived,
            pinned=participant.pinned,
            muted=participant.muted,
        )

    async def list_threads(self, db: Session, user_id: str, page: int, limit: int, archived: bool | None = None) -> tuple[list[ChatThreadRead], bool]:
        statement = (
            select(ChatThread)
            .join(ChatParticipant, ChatParticipant.thread_id == ChatThread.id)
            .where(ChatParticipant.user_id == user_id)
        )
        if archived is not None:
            statement = statement.where(ChatParticipant.archived == archived)
        rows = list(
            db.scalars(
                statement.order_by(ChatParticipant.pinned.desc(), ChatThread.updated_at.desc())
                .offset((page - 1) * limit)
                .limit(limit + 1)
            )
        )
        return [await self.serialize_thread(db, thread, user_id) for thread in rows[:limit]], len(rows) > limit

    def list_messages(self, db: Session, thread_id: str, user_id: str, before: datetime | None, limit: int) -> tuple[list[ChatMessageRead], bool]:
        self.participant(db, thread_id, user_id)
        statement = select(ChatMessage).where(ChatMessage.thread_id == thread_id, ChatMessage.deleted_at.is_(None))
        if before:
            statement = statement.where(ChatMessage.created_at < before)
        rows = list(db.scalars(statement.order_by(ChatMessage.created_at.desc()).limit(limit + 1)))
        messages = [self.serialize_message(db, message, user_id) for message in reversed(rows[:limit])]
        return messages, len(rows) > limit

    async def publish(self, user_id: str, event: dict[str, Any]) -> int:
        try:
            return await presence_service.publish(user_id, event)
        except RealtimeUnavailable:
            return 0

    async def send_message(self, db: Session, thread_id: str, sender: User, payload: dict[str, Any]) -> ChatMessage:
        participant = self.participant(db, thread_id, sender.id)
        peer_id = self.peer_id_for(db, thread_id, sender.id)
        if not self.can_message(db, sender.id, peer_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Messaging is not allowed with this user.")
        client_message_id = str(payload.get("client_message_id") or "").strip() or None
        if client_message_id:
            existing = db.scalar(
                select(ChatMessage).where(
                    ChatMessage.thread_id == thread_id,
                    ChatMessage.sender_id == sender.id,
                    ChatMessage.client_message_id == client_message_id,
                )
            )
            if existing:
                return existing
        message_type = str(payload.get("message_type") or "text")
        text_content = str(payload.get("text_content") or "").strip() or None
        if message_type == "text" and not text_content:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Message text is required.")
        if message_type != "text" and not payload.get("attachment_url"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Attachment is required.")
        message = ChatMessage(
            thread_id=thread_id,
            sender_id=sender.id,
            client_message_id=client_message_id,
            message_type=message_type,
            text_content=text_content,
            attachment_url=payload.get("attachment_url"),
            attachment_name=payload.get("attachment_name"),
            attachment_size=payload.get("attachment_size"),
            mime_type=payload.get("mime_type"),
            reply_to_message_id=payload.get("reply_to_message_id"),
        )
        db.add(message)
        db.flush()
        thread = db.get(ChatThread, thread_id)
        if thread:
            thread.last_message_id = message.id
            thread.updated_at = utcnow()
        participant.archived = False
        participants = self.thread_participants(db, thread_id)
        now = utcnow()
        for item in participants:
            db.add(
                MessageReceipt(
                    message_id=message.id,
                    user_id=item.user_id,
                    delivered_at=now if item.user_id == sender.id else None,
                    read_at=now if item.user_id == sender.id else None,
                )
            )
            if item.user_id != sender.id:
                item.archived = False
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            if client_message_id:
                existing = db.scalar(
                    select(ChatMessage).where(
                        ChatMessage.thread_id == thread_id,
                        ChatMessage.sender_id == sender.id,
                        ChatMessage.client_message_id == client_message_id,
                    )
                )
                if existing:
                    return existing
            raise
        db.refresh(message)
        serialized = self.serialize_message(db, message, sender.id).model_dump(mode="json")
        for item in participants:
            await self.publish(item.user_id, chat_event("message.new", sender.id, {"message": serialized}, thread_id))
            await self.publish(item.user_id, chat_event("thread.updated", sender.id, {"thread_id": thread_id}, thread_id))
            if item.user_id != sender.id and not item.muted:
                send_chat_message_notifications(db, item.user_id, sender, message)
        db.commit()
        return message

    async def mark_delivered(self, db: Session, thread_id: str, user_id: str) -> None:
        self.participant(db, thread_id, user_id)
        now = utcnow()
        receipts = list(
            db.scalars(
                select(MessageReceipt)
                .join(ChatMessage, ChatMessage.id == MessageReceipt.message_id)
                .where(ChatMessage.thread_id == thread_id, MessageReceipt.user_id == user_id, MessageReceipt.delivered_at.is_(None))
            )
        )
        for receipt in receipts:
            receipt.delivered_at = now
        db.commit()
        if receipts:
            await self._publish_receipt_update(db, thread_id, "message.delivered", user_id)

    async def mark_pending_delivered_for_user(self, db: Session, user_id: str) -> int:
        rows = list(
            db.execute(
                select(MessageReceipt, ChatMessage.thread_id)
                .join(ChatMessage, ChatMessage.id == MessageReceipt.message_id)
                .join(ChatParticipant, ChatParticipant.thread_id == ChatMessage.thread_id)
                .where(
                    ChatParticipant.user_id == user_id,
                    MessageReceipt.user_id == user_id,
                    MessageReceipt.delivered_at.is_(None),
                    ChatMessage.sender_id != user_id,
                    ChatMessage.deleted_at.is_(None),
                )
            ).all()
        )
        if not rows:
            return 0
        now = utcnow()
        thread_ids = sorted({thread_id for _, thread_id in rows})
        for receipt, _ in rows:
            receipt.delivered_at = now
        db.commit()
        for thread_id in thread_ids:
            await self._publish_receipt_update(db, thread_id, "message.delivered", user_id)
        return len(rows)

    async def mark_read(self, db: Session, thread_id: str, user_id: str) -> None:
        participant = self.participant(db, thread_id, user_id)
        now = utcnow()
        latest = db.scalar(select(ChatMessage).where(ChatMessage.thread_id == thread_id).order_by(ChatMessage.created_at.desc()).limit(1))
        participant.last_read_at = now
        if latest:
            participant.last_read_message_id = latest.id
        receipts = list(
            db.scalars(
                select(MessageReceipt)
                .join(ChatMessage, ChatMessage.id == MessageReceipt.message_id)
                .where(ChatMessage.thread_id == thread_id, MessageReceipt.user_id == user_id)
            )
        )
        settings_record = self.get_or_create_settings(db, user_id)
        for receipt in receipts:
            receipt.delivered_at = receipt.delivered_at or now
            if settings_record.read_receipts_enabled:
                receipt.read_at = receipt.read_at or now
        db.commit()
        await self._publish_receipt_update(db, thread_id, "message.read", user_id)

    async def _publish_receipt_update(self, db: Session, thread_id: str, event_type: str, actor_user_id: str) -> None:
        for item in self.thread_participants(db, thread_id):
            await self.publish(item.user_id, chat_event(event_type, actor_user_id, {"thread_id": thread_id, "user_id": actor_user_id}, thread_id))

    async def set_thread_flag(self, db: Session, thread_id: str, user_id: str, field: str, enabled: bool) -> ChatParticipant:
        participant = self.participant(db, thread_id, user_id)
        setattr(participant, field, enabled)
        db.commit()
        db.refresh(participant)
        await self.publish(user_id, chat_event("thread.updated", user_id, {"thread_id": thread_id}, thread_id))
        return participant

    async def search_users(self, db: Session, current_user: User, query: str, page: int, limit: int) -> tuple[list[ChatPublicUser], bool]:
        normalized = " ".join(query.strip().split())
        if len(normalized) < 2:
            return [], False
        blocked = exists(
            select(BlockedUser.id).where(
                or_(
                    and_(BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_user_id == User.id),
                    and_(BlockedUser.blocker_id == User.id, BlockedUser.blocked_user_id == current_user.id),
                )
            )
        )
        escaped = normalized.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        rows = list(
            db.execute(
                select(User, UserCallSettings)
                .join(UserCallSettings, UserCallSettings.user_id == User.id)
                .where(
                    User.id != current_user.id,
                    User.is_active == True,  # noqa: E712
                    User.username.is_not(None),
                    User.username != "",
                    User.name != "",
                    UserCallSettings.is_discoverable == True,  # noqa: E712
                    or_(User.name.ilike(pattern, escape="\\"), User.username.ilike(pattern, escape="\\")),
                    ~blocked,
                )
                .order_by(User.name.asc(), User.id.asc())
                .offset((page - 1) * limit)
                .limit(limit + 1)
            ).all()
        )
        return [await self.public_user(db, user, current_user.id) for user, _ in rows[:limit]], len(rows) > limit

    async def save_attachment(self, file: UploadFile, user_id: str) -> dict[str, Any]:
        content_type = file.content_type or "application/octet-stream"
        if not (content_type.startswith(ALLOWED_CHAT_MIME_PREFIXES) or content_type in {"application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File type is not allowed.")
        raw = await file.read()
        if not raw or len(raw) > MAX_CHAT_ATTACHMENT_BYTES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File size is not allowed.")
        root = Path(settings.UPLOAD_DIR, "chat", user_id)
        root.mkdir(parents=True, exist_ok=True)
        suffix = Path(file.filename or "upload").suffix.lower()[:12]
        name = f"{uuid.uuid4().hex}{suffix}"
        path = root / name
        path.write_bytes(raw)
        relative = f"/uploads/chat/{user_id}/{name}"
        return {
            "attachment_url": relative,
            "attachment_name": file.filename or name,
            "attachment_size": len(raw),
            "mime_type": content_type,
            "message_type": "image" if content_type.startswith("image/") else "file",
        }


user_chat_service = UserChatService()
