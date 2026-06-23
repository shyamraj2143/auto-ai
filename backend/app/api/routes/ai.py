import json
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.document import Document
from app.models.message import Message
from app.models.search import SearchRun
from app.models.user import User
from app.schemas.chat import ChatRead, ChatRequest, ChatResponse, CodeAssistRequest, CodeAssistResponse
from app.schemas.search import SearchResultBundle
from app.services.document_service import document_service
from app.services.groq_service import groq_service
from app.services.human import AUTO_AI_HUMAN_MODE_PROMPT, meta_cognition_layer
from app.services.web_search import SearchAgent, web_search_service


router = APIRouter(prefix="/ai", tags=["ai"])


DEFAULT_CHAT_SYSTEM_PROMPT = (
    AUTO_AI_HUMAN_MODE_PROMPT
    + "\n\nFormat answers like ChatGPT: start with the direct answer, use clear short paragraphs, "
    "use bullets or numbered steps only when they improve readability, keep code in fenced blocks, "
    "and avoid unnecessary preambles."
)


def title_from_message(message: str) -> str:
    title = " ".join(message.strip().split())
    return title[:60] + ("..." if len(title) > 60 else "")


def get_or_create_chat(
    db: Session,
    current_user: User,
    payload: ChatRequest,
) -> Chat:
    if payload.chat_id:
        chat = db.scalar(
            select(Chat)
            .where(Chat.id == payload.chat_id, Chat.user_id == current_user.id)
            .options(selectinload(Chat.messages))
        )
        if not chat:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")
        return chat

    chat = Chat(
        user_id=current_user.id,
        title=payload.title or title_from_message(payload.message),
        system_prompt=payload.system_prompt,
        model=payload.model or settings.chat_model_for(payload.provider),
    )
    db.add(chat)
    db.commit()
    db.refresh(chat)
    return chat


def load_documents(db: Session, user_id: str, document_ids: list[str]) -> list[Document]:
    if not document_ids:
        return []
    return list(
        db.scalars(
            select(Document).where(Document.user_id == user_id, Document.id.in_(document_ids))
        )
    )


def build_messages(
    chat: Chat,
    user_message: str,
    documents: list[Document],
    *,
    system_prompt: str | None,
    reasoning: bool,
    adaptive_context: str | None = None,
    search_context: str | None = None,
) -> list[dict[str, str]]:
    base_prompt = (
        system_prompt
        or chat.system_prompt
        or DEFAULT_CHAT_SYSTEM_PROMPT
    )
    if reasoning:
        base_prompt += (
            "\nUse deliberate reasoning internally. Provide concise final answers and only show "
            "step-by-step reasoning when the user explicitly asks for it."
        )

    messages: list[dict[str, str]] = [{"role": "system", "content": base_prompt}]
    if adaptive_context:
        messages.append({"role": "system", "content": adaptive_context})

    document_context = document_service.document_context(
        [(doc.filename, doc.extracted_text) for doc in documents]
    )
    if document_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Use the following uploaded document context when it is relevant. "
                    "If the answer is not in the documents, say so clearly.\n\n"
                    f"{document_context}"
                ),
            }
        )
    if search_context:
        messages.append({"role": "system", "content": search_context})

    history = chat.messages[-settings.MAX_CONTEXT_MESSAGES :] if chat.messages else []
    messages.extend({"role": msg.role, "content": msg.content} for msg in history)
    messages.append({"role": "user", "content": user_message})
    return messages


def search_payload(bundle: SearchResultBundle | None) -> dict:
    if not bundle or not bundle.searched:
        return {}
    return {"search": bundle.model_dump(mode="json")}


def attach_search_run_to_message(db: Session, bundle: SearchResultBundle | None, message_id: str) -> None:
    if not bundle or not bundle.run_id:
        return
    run = db.get(SearchRun, bundle.run_id)
    if run:
        run.message_id = message_id


def run_search_for_chat(
    db: Session,
    *,
    current_user: User,
    chat_id: str,
    payload: ChatRequest,
    message_id: str | None = None,
) -> SearchResultBundle | None:
    mode = SearchAgent.effective_mode(payload.search_mode, payload.web_search)
    result = web_search_service.execute(
        db,
        user_id=current_user.id,
        query=payload.message,
        mode=mode,
        chat_id=chat_id,
        message_id=message_id,
    )
    return result if result.searched else None


def record_usage(
    db: Session,
    user_id: str,
    endpoint: str,
    model: str,
    usage: dict[str, int],
) -> None:
    db.add(
        APIUsage(
            user_id=user_id,
            endpoint=endpoint,
            model=model,
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        )
    )


@router.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    chat_row = get_or_create_chat(db, current_user, payload)
    documents = load_documents(db, current_user.id, payload.document_ids)
    history = chat_row.messages[-settings.MAX_CONTEXT_MESSAGES :] if chat_row.messages else []
    prepared_context = meta_cognition_layer.prepare_context(
        db,
        user_id=current_user.id,
        chat_id=chat_row.id,
        user_message=payload.message,
        history=history,
    )
    search_bundle = run_search_for_chat(
        db,
        current_user=current_user,
        chat_id=chat_row.id,
        payload=payload,
    )
    messages = build_messages(
        chat_row,
        payload.message,
        documents,
        system_prompt=payload.system_prompt,
        reasoning=payload.reasoning,
        adaptive_context=prepared_context["prompt_context"],
        search_context=web_search_service.build_model_context(search_bundle),
    )

    user_message = Message(chat_id=chat_row.id, role="user", content=payload.message)
    db.add(user_message)
    db.flush()
    content, usage, selected_model = groq_service.complete(
        messages,
        model=payload.model or chat_row.model,
        provider=payload.provider,
        web_search=False,
    )
    content = web_search_service.ensure_citations(content, search_bundle)
    assistant_message = Message(
        chat_id=chat_row.id,
        role="assistant",
        content=content,
        token_count=usage.get("completion_tokens", 0),
        message_metadata=search_payload(search_bundle),
    )
    chat_row.model = payload.model or chat_row.model
    chat_row.updated_at = datetime.utcnow()
    db.add(assistant_message)
    db.flush()
    attach_search_run_to_message(db, search_bundle, assistant_message.id)
    meta_cognition_layer.complete_turn(
        db,
        user_id=current_user.id,
        chat_id=chat_row.id,
        user_message=payload.message,
        prepared=prepared_context,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
    )
    record_usage(db, current_user.id, "chat", selected_model, usage)
    db.commit()
    db.refresh(chat_row)
    db.refresh(assistant_message)
    return ChatResponse(chat=ChatRead.model_validate(chat_row), assistant_message=assistant_message)


@router.post("/chat/stream")
def stream_chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    chat_row = get_or_create_chat(db, current_user, payload)
    documents = load_documents(db, current_user.id, payload.document_ids)
    history = chat_row.messages[-settings.MAX_CONTEXT_MESSAGES :] if chat_row.messages else []
    prepared_context = meta_cognition_layer.prepare_context(
        db,
        user_id=current_user.id,
        chat_id=chat_row.id,
        user_message=payload.message,
        history=history,
    )
    messages = build_messages(
        chat_row,
        payload.message,
        documents,
        system_prompt=payload.system_prompt,
        reasoning=payload.reasoning,
        adaptive_context=prepared_context["prompt_context"],
    )
    user_message = Message(chat_id=chat_row.id, role="user", content=payload.message)
    db.add(user_message)
    model_name = payload.model or chat_row.model
    chat_row.model = model_name
    chat_row.updated_at = datetime.utcnow()
    db.flush()
    user_message_id = user_message.id
    db.commit()

    selected_model = groq_service.selected_model(
        model_name,
        provider=payload.provider,
        web_search=False,
    )
    chat_id = chat_row.id
    user_id = current_user.id
    search_mode = SearchAgent.effective_mode(payload.search_mode, payload.web_search)

    def event_generator():
        assistant_content: list[str] = []
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        yield f"data: {json.dumps({'type': 'meta', 'chat_id': chat_id})}\n\n"

        try:
            search_bundle: SearchResultBundle | None = None
            should_search, _ = SearchAgent.should_search(payload.message, search_mode)
            model_messages = messages
            if should_search:
                yield f"data: {json.dumps({'type': 'searching', 'mode': search_mode, 'message': 'Searching the web...'})}\n\n"
                with SessionLocal() as search_db:
                    search_bundle = web_search_service.execute(
                        search_db,
                        user_id=user_id,
                        query=payload.message,
                        mode=search_mode,
                        chat_id=chat_id,
                        message_id=user_message_id,
                    )
                    search_db.commit()
                search_context = web_search_service.build_model_context(search_bundle)
                if search_context:
                    model_messages = [
                        *messages[:-1],
                        {"role": "system", "content": search_context},
                        messages[-1],
                    ]
                yield f"data: {json.dumps({'type': 'sources', 'search': search_bundle.model_dump(mode='json')})}\n\n"

            stream = groq_service.stream(
                model_messages,
                model=model_name,
                provider=payload.provider,
                web_search=False,
            )
            for chunk in stream:
                delta = groq_service.extract_stream_delta(chunk)
                chunk_usage = groq_service.extract_usage(chunk)
                if chunk_usage["total_tokens"]:
                    usage = chunk_usage
                if delta:
                    assistant_content.append(delta)
                    yield f"data: {json.dumps({'type': 'delta', 'delta': delta})}\n\n"

            final_content = web_search_service.ensure_citations("".join(assistant_content), search_bundle)
            existing_content = "".join(assistant_content)
            citation_delta = final_content[len(existing_content) :]
            if citation_delta:
                assistant_content.append(citation_delta)
                yield f"data: {json.dumps({'type': 'delta', 'delta': citation_delta})}\n\n"

            with SessionLocal() as stream_db:
                message = Message(
                    chat_id=chat_id,
                    role="assistant",
                    content="".join(assistant_content),
                    token_count=usage.get("completion_tokens", 0),
                    message_metadata=search_payload(search_bundle),
                )
                chat_record = stream_db.get(Chat, chat_id)
                if chat_record:
                    chat_record.updated_at = datetime.utcnow()
                stream_db.add(message)
                stream_db.flush()
                attach_search_run_to_message(stream_db, search_bundle, message.id)
                meta_cognition_layer.complete_turn(
                    stream_db,
                    user_id=user_id,
                    chat_id=chat_id,
                    user_message=payload.message,
                    prepared=prepared_context,
                    user_message_id=user_message_id,
                    assistant_message_id=message.id,
                )
                record_usage(stream_db, user_id, "chat_stream", selected_model, usage)
                stream_db.commit()
                stream_db.refresh(message)
                yield f"data: {json.dumps({'type': 'done', 'message_id': message.id})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(exc)})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/image-analysis")
async def image_analysis(
    file: UploadFile = File(...),
    prompt: str = Form("Analyze this image in detail."),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in settings.ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Supported image formats are PNG, JPG, JPEG, WEBP, and GIF.",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded image is empty.")
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image exceeds {settings.MAX_UPLOAD_MB} MB.",
        )
    content = groq_service.analyze_image(data, file.filename or "image.png", prompt)
    record_usage(
        db,
        current_user.id,
        "image_analysis",
        settings.GROQ_VISION_MODEL,
        {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    )
    db.commit()
    return {"content": content, "model": settings.GROQ_VISION_MODEL}


@router.post("/code", response_model=CodeAssistResponse)
def code_assist(
    payload: CodeAssistRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CodeAssistResponse:
    mode_prompt = {
        "generate": "Generate production-quality code for the request.",
        "debug": "Debug the provided code. Identify likely causes and provide a corrected version.",
        "explain": "Explain the provided code clearly and highlight important implementation details.",
    }[payload.mode]
    code_block = f"\n\nCode ({payload.language or 'unknown'}):\n```{payload.language or ''}\n{payload.code}\n```" if payload.code else ""
    messages = [
        {"role": "system", "content": "You are Auto-AI, an expert programming assistant."},
        {"role": "user", "content": f"{mode_prompt}\n\n{payload.prompt}{code_block}"},
    ]
    content, usage, selected_model = groq_service.complete(messages, model=payload.model)
    record_usage(db, current_user.id, "code", selected_model, usage)
    db.commit()
    return CodeAssistResponse(content=content, model=selected_model)
