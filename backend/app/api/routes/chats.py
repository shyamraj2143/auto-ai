from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import select

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.message import Message
from app.models.user import User
from app.repositories.sqlalchemy import SQLAlchemyChatRepository
from app.schemas.chat import ChatCreate, ChatListItem, ChatRead, ChatUpdate
from app.services.chat_storage import clear_chat_message_storage, delete_chat_storage, sync_chat_history, sync_chat_session


router = APIRouter(prefix="/chats", tags=["chats"])


@router.get("", response_model=list[ChatListItem])
def list_chats(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chats = SQLAlchemyChatRepository(db).list_for_user(current_user.id)
    for chat in chats:
        sync_chat_session(db, chat)
    db.commit()
    return chats


@router.post("", response_model=ChatRead, status_code=status.HTTP_201_CREATED)
def create_chat(
    payload: ChatCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = Chat(
        user_id=current_user.id,
        title=payload.title or "New chat",
        system_prompt=payload.system_prompt,
        model=payload.model or settings.default_chat_model,
        mode=payload.mode,
    )
    db.add(chat)
    db.flush()
    sync_chat_session(db, chat)
    db.commit()
    db.refresh(chat)
    return chat


@router.get("/{chat_id}", response_model=ChatRead)
def get_chat(
    chat_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = db.scalar(
        select(Chat)
        .where(Chat.id == chat_id, Chat.user_id == current_user.id)
        .options(selectinload(Chat.messages))
    )
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    sync_chat_history(db, chat)
    db.commit()
    return chat


@router.patch("/{chat_id}", response_model=ChatRead)
def update_chat(
    chat_id: str,
    payload: ChatUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = SQLAlchemyChatRepository(db).get_for_user(chat_id, current_user.id)
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

    updates = payload.model_dump(exclude_unset=True)
    clear_messages = bool(updates.pop("clear_messages", False))
    for key, value in updates.items():
        setattr(chat, key, value)
    if clear_messages:
        db.query(ChatGeneration).filter(ChatGeneration.chat_id == chat.id).delete(synchronize_session=False)
        db.query(Message).filter(Message.chat_id == chat.id).delete(synchronize_session=False)
        clear_chat_message_storage(db, chat.id)
    chat.updated_at = datetime.utcnow()
    db.add(chat)
    db.flush()
    sync_chat_session(db, chat)
    db.commit()
    db.refresh(chat)
    return chat


@router.delete("/{chat_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_chat(
    chat_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = SQLAlchemyChatRepository(db).get_for_user(chat_id, current_user.id)
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
    delete_chat_storage(db, chat.id)
    db.delete(chat)
    db.commit()
    return None
