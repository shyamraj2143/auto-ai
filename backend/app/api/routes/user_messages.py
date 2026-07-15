from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.models.user_chat import ChatThread
from app.schemas.user_chat import (
    ChatMessageRead,
    ChatSettingsRead,
    ChatSettingsUpdate,
    ChatThreadPage,
    ChatThreadRead,
    ChatUserPage,
    MessageCreateRequest,
    ThreadCreateRequest,
    ThreadFlagRequest,
)
from app.services.user_chat_service import user_chat_service


router = APIRouter(prefix="/messages", tags=["user-messages"])


@router.get("", response_model=ChatThreadPage)
async def list_threads(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=30, ge=1, le=80),
    archived: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadPage:
    items, has_more = await user_chat_service.list_threads(db, current_user.id, page, limit, archived)
    return ChatThreadPage(items=items, page=page, limit=limit, has_more=has_more)


@router.get("/search-users", response_model=ChatUserPage)
async def search_chat_users(
    query: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatUserPage:
    items, has_more = await user_chat_service.search_users(db, current_user, query, page, limit)
    return ChatUserPage(items=items, page=page, limit=limit, has_more=has_more)


@router.post("/threads", response_model=ChatThreadRead, status_code=status.HTTP_201_CREATED)
async def create_thread(
    payload: ThreadCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadRead:
    thread = user_chat_service.create_or_get_thread(db, current_user, payload.peer_user_id)
    return await user_chat_service.serialize_thread(db, thread, current_user.id)


@router.get("/threads/{thread_id}", response_model=ChatThreadRead)
async def get_thread(
    thread_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatThreadRead:
    participant = user_chat_service.participant(db, thread_id, current_user.id)
    thread = db.get(ChatThread, participant.thread_id)
    if not thread:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat thread not found.")
    return await user_chat_service.serialize_thread(db, thread, current_user.id)


@router.get("/threads/{thread_id}/messages")
def list_messages(
    thread_id: str,
    before: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    items, has_more = user_chat_service.list_messages(db, thread_id, current_user.id, before, limit)
    return {"items": items, "has_more": has_more}


@router.post("/threads/{thread_id}/messages", response_model=ChatMessageRead, status_code=status.HTTP_201_CREATED)
async def send_message(
    thread_id: str,
    payload: MessageCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatMessageRead:
    message = await user_chat_service.send_message(db, thread_id, current_user, payload.model_dump())
    return user_chat_service.serialize_message(db, message, current_user.id)


@router.post("/threads/{thread_id}/attachments", response_model=ChatMessageRead, status_code=status.HTTP_201_CREATED)
async def send_attachment(
    thread_id: str,
    file: UploadFile = File(...),
    text_content: str | None = Form(default=None),
    client_message_id: str | None = Form(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ChatMessageRead:
    attachment = await user_chat_service.save_attachment(file, current_user.id)
    attachment["text_content"] = (text_content or "").strip() or None
    attachment["client_message_id"] = client_message_id
    message = await user_chat_service.send_message(db, thread_id, current_user, attachment)
    return user_chat_service.serialize_message(db, message, current_user.id)


@router.delete("/threads/{thread_id}/messages/{message_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_message(
    thread_id: str,
    message_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await user_chat_service.delete_message(db, thread_id, message_id, current_user.id)
    return None


@router.post("/threads/{thread_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(thread_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await user_chat_service.mark_read(db, thread_id, current_user.id)
    return None


@router.post("/threads/{thread_id}/delivered", status_code=status.HTTP_204_NO_CONTENT)
async def mark_delivered(thread_id: str, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await user_chat_service.mark_delivered(db, thread_id, current_user.id)
    return None


@router.post("/threads/{thread_id}/archive", response_model=ChatThreadRead)
async def archive_thread(thread_id: str, payload: ThreadFlagRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await user_chat_service.set_thread_flag(db, thread_id, current_user.id, "archived", payload.enabled)
    thread = user_chat_service.participant(db, thread_id, current_user.id)
    return await get_thread(thread.thread_id, db, current_user)


@router.post("/threads/{thread_id}/pin", response_model=ChatThreadRead)
async def pin_thread(thread_id: str, payload: ThreadFlagRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await user_chat_service.set_thread_flag(db, thread_id, current_user.id, "pinned", payload.enabled)
    thread = user_chat_service.participant(db, thread_id, current_user.id)
    return await get_thread(thread.thread_id, db, current_user)


@router.post("/threads/{thread_id}/mute", response_model=ChatThreadRead)
async def mute_thread(thread_id: str, payload: ThreadFlagRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    await user_chat_service.set_thread_flag(db, thread_id, current_user.id, "muted", payload.enabled)
    thread = user_chat_service.participant(db, thread_id, current_user.id)
    return await get_thread(thread.thread_id, db, current_user)


@router.get("/settings", response_model=ChatSettingsRead)
def get_chat_settings(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    record = user_chat_service.get_or_create_settings(db, current_user.id)
    db.commit()
    return record


@router.patch("/settings", response_model=ChatSettingsRead)
def update_chat_settings(payload: ChatSettingsUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    record = user_chat_service.get_or_create_settings(db, current_user.id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, key, value)
    db.commit()
    db.refresh(record)
    return record
