from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.api.routes.ai import (
    RUNNING_GENERATION_STATUSES,
    TERMINAL_GENERATION_STATUSES,
    create_chat_generation,
    generation_payload,
    title_from_message,
    update_generation_message,
)
from app.core.config import settings
from app.db.session import get_db
from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.message import Message
from app.models.user import User
from app.schemas.chat import (
    ChatCreate,
    ChatGenerationRead,
    ChatListItem,
    ChatRead,
    ChatRegenerateRequest,
    ChatRequest,
    ChatUpdate,
)
from app.services.chat_storage import (
    clear_chat_message_storage,
    delete_chat_storage,
    sync_chat_history,
    sync_chat_message,
    sync_chat_session,
)


router = APIRouter(prefix="/chat/sessions", tags=["chat-sessions"])


def get_session_or_404(db: Session, session_id: str, user_id: str, *, with_messages: bool = False) -> Chat:
    statement = select(Chat).where(Chat.id == session_id, Chat.user_id == user_id)
    if with_messages:
        statement = statement.options(selectinload(Chat.messages))
    chat = db.scalar(statement)
    if not chat:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat session not found")
    return chat


def request_for_session(session_id: str, payload: ChatRequest) -> ChatRequest:
    data = payload.model_dump(mode="json")
    data["chat_id"] = session_id
    return ChatRequest.model_validate(data)


@router.post("", response_model=ChatRead, status_code=status.HTTP_201_CREATED)
def create_session(
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


@router.get("", response_model=list[ChatListItem])
def list_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    chats = list(
        db.scalars(select(Chat).where(Chat.user_id == current_user.id).order_by(Chat.updated_at.desc()))
    )
    for chat in chats:
        sync_chat_session(db, chat)
    db.commit()
    return chats


@router.get("/{session_id}", response_model=ChatRead)
def get_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_session_or_404(db, session_id, current_user.id, with_messages=True)
    sync_chat_history(db, chat)
    db.commit()
    return chat


@router.post("/{session_id}/messages", response_model=ChatGenerationRead, status_code=status.HTTP_202_ACCEPTED)
def create_session_message(
    session_id: str,
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_session_or_404(db, session_id, current_user.id, with_messages=True)
    if not any(message.role == "user" for message in chat.messages or []) and chat.title.strip().lower() == "new chat":
        chat.title = title_from_message(payload.message)
    chat.mode = payload.mode
    db.add(chat)
    db.flush()
    return create_chat_generation(request_for_session(session_id, payload), current_user, db)


@router.patch("/{session_id}", response_model=ChatRead)
def update_session(
    session_id: str,
    payload: ChatUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_session_or_404(db, session_id, current_user.id, with_messages=True)
    updates = payload.model_dump(exclude_unset=True)
    clear_messages = bool(updates.pop("clear_messages", False))
    for key, value in updates.items():
        setattr(chat, key, value)
    if clear_messages:
        db.execute(delete(ChatGeneration).where(ChatGeneration.chat_id == chat.id))
        db.execute(delete(Message).where(Message.chat_id == chat.id))
        clear_chat_message_storage(db, chat.id)
    chat.updated_at = datetime.utcnow()
    db.add(chat)
    db.flush()
    sync_chat_session(db, chat)
    if not clear_messages:
        sync_chat_history(db, chat)
    db.commit()
    db.refresh(chat)
    return get_session_or_404(db, session_id, current_user.id, with_messages=True)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_session_or_404(db, session_id, current_user.id)
    delete_chat_storage(db, chat.id)
    db.delete(chat)
    db.commit()
    return None


@router.post("/{session_id}/regenerate", response_model=ChatGenerationRead, status_code=status.HTTP_202_ACCEPTED)
def regenerate_session_message(
    session_id: str,
    payload: ChatRegenerateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chat = get_session_or_404(db, session_id, current_user.id, with_messages=True)
    messages = list(chat.messages or [])
    if not messages:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No messages to regenerate.")

    if payload.message_id:
        target_index = next((index for index, message in enumerate(messages) if message.id == payload.message_id), -1)
    else:
        target_index = next((index for index in range(len(messages) - 1, -1, -1) if messages[index].role == "assistant"), -1)
    if target_index < 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Assistant response not found.")

    previous_user = next(
        (message for message in reversed(messages[:target_index]) if message.role == "user"),
        None,
    )
    if not previous_user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No user prompt found for regeneration.")

    removed_ids = [message.id for message in messages[target_index:]]
    db.execute(
        delete(ChatGeneration).where(
            ChatGeneration.chat_id == chat.id,
            (
                ChatGeneration.assistant_message_id.in_(removed_ids)
                | ChatGeneration.user_message_id.in_(removed_ids)
            ),
        )
    )
    for message in messages[target_index:]:
        db.delete(message)
    clear_chat_message_storage(db, chat.id)
    db.flush()
    sync_chat_session(db, chat)
    for message in messages[:target_index]:
        sync_chat_message(db, message, user_id=current_user.id, model=chat.model)

    request_payload = ChatRequest(
        message=previous_user.content,
        chat_id=chat.id,
        title=chat.title,
        system_prompt=chat.system_prompt,
        mode=payload.mode,
        providers=payload.providers,
        max_models=payload.max_models,
        all_models=payload.all_models,
        timeout_seconds=payload.timeout_seconds,
        groq_models=payload.groq_models,
        bedrock_models=payload.bedrock_models,
        openai_models=payload.openai_models,
        gemini_models=payload.gemini_models,
        final_judge_model=payload.final_judge_model,
        provider=payload.provider,
        model=payload.model,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        reasoning=payload.reasoning,
        document_ids=payload.document_ids,
    )
    return create_chat_generation(request_payload, current_user, db, existing_user_message=previous_user)


@router.post("/{session_id}/stop", response_model=ChatGenerationRead)
def stop_session_generation(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_session_or_404(db, session_id, current_user.id)
    generation = db.scalar(
        select(ChatGeneration)
        .where(
            ChatGeneration.chat_id == session_id,
            ChatGeneration.user_id == current_user.id,
            ChatGeneration.status.in_(RUNNING_GENERATION_STATUSES),
        )
        .order_by(ChatGeneration.updated_at.desc())
    )
    if not generation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active response is running.")
    if generation.status in TERMINAL_GENERATION_STATUSES:
        return generation_payload(db, generation)

    generation.status = "cancel_requested"
    generation.updated_at = datetime.utcnow()
    assistant_message = db.get(Message, generation.assistant_message_id) if generation.assistant_message_id else None
    if assistant_message:
        update_generation_message(
            db,
            generation=generation,
            assistant_message=assistant_message,
            content=assistant_message.content,
            status_value="cancel_requested",
        )
    db.commit()
    db.refresh(generation)
    return generation_payload(db, generation)
