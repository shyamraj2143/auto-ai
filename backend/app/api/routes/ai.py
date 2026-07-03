import json
import re
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
from app.schemas.chat import ChatRead, ChatRequest, ChatResponse, CodeAssistRequest, CodeAssistResponse, ResearchModelOptions
from app.schemas.search import SearchResultBundle
from app.services.admin_control import enforce_plan_and_feature_access, record_usage_log
from app.services.deep_research import deep_research_service
from app.services.document_service import document_service
from app.services.groq_service import groq_service
from app.services.human import AUTO_AI_HUMAN_MODE_PROMPT, meta_cognition_layer
from app.services.web_search import SearchAgent, web_search_service


router = APIRouter(prefix="/ai", tags=["ai"])


DEFAULT_CHAT_SYSTEM_PROMPT = (
    AUTO_AI_HUMAN_MODE_PROMPT
    + "\n\nFormat answers clearly: start with the direct answer, use clear short paragraphs, "
    "use bullets or numbered steps only when they improve readability, keep code in fenced blocks, "
    "and avoid unnecessary preambles. Never reveal hidden reasoning, scratchpad text, or <think> blocks."
)

THINK_BLOCK_PATTERN = re.compile(r"<think\b[^>]*>.*?</think>\s*", re.IGNORECASE | re.DOTALL)
OPEN_THINK_BLOCK_PATTERN = re.compile(r"<think\b[^>]*>.*$", re.IGNORECASE | re.DOTALL)
MODEL_IDENTITY_PATTERN = re.compile(
    r"\b("
    r"your model|model name|which model|what model|underlying model|"
    r"tumhara model|aapka model|kaun sa model|kon sa model"
    r")\b",
    re.IGNORECASE,
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
    runtime_identity: str | None = None,
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
    if runtime_identity:
        messages.append({"role": "system", "content": runtime_identity})
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


def deep_research_payload(metadata: dict | None) -> dict:
    return {"deep_research": metadata} if metadata else {}


def model_payload(provider: str, model: str) -> dict:
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI"}.get(provider, provider)
    return {"model": {"provider": provider, "provider_label": provider_name, "model": model}}


def clean_model_output(content: str) -> str:
    without_closed_thoughts = THINK_BLOCK_PATTERN.sub("", content)
    return OPEN_THINK_BLOCK_PATTERN.sub("", without_closed_thoughts).strip()


def is_model_identity_question(message: str) -> bool:
    return bool(MODEL_IDENTITY_PATTERN.search(message.strip()))


def model_identity_answer(provider: str, model: str) -> str:
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI"}[provider]
    return f"I am Auto-AI. This response is using {provider_name} / {model}."


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
    record_usage_log(db, user_id, endpoint, model, usage)


def runtime_identity_prompt(provider: str | None, model: str | None, *, mode: str) -> str:
    if mode in {"deep_research", "multi_model"}:
        return (
            "Runtime identity: You are Auto-AI using Deep Research / Multi-Model mode. "
            "If the user asks which model is being used, say this mode consults the selected Groq/Bedrock research models and synthesizes one answer. "
            "Do not claim to be ChatGPT, GPT-4, or any other unrelated model."
        )

    selected_provider = groq_service.selected_provider(provider)
    selected_model = groq_service.selected_model(model, provider=selected_provider, web_search=False)
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI"}[selected_provider]
    return (
        f"Runtime identity: You are Auto-AI using provider {provider_name} with model id {selected_model} for this request. "
        f"If the user asks your model name or architecture, answer exactly with {provider_name} / {selected_model}. "
        "Do not claim to be ChatGPT, GPT-4, Claude, or another model unless that is the selected model id/provider. "
        "Never output hidden reasoning, scratchpad text, or <think> blocks."
    )


@router.get("/research-models", response_model=ResearchModelOptions)
def research_models(_: User = Depends(get_current_user)) -> dict:
    return deep_research_service.model_options()


@router.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    enforce_plan_and_feature_access(
        db,
        current_user,
        mode=payload.mode,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        max_models=payload.max_models,
    )
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
        runtime_identity=runtime_identity_prompt(payload.provider, payload.model or chat_row.model, mode=payload.mode),
    )

    user_message = Message(chat_id=chat_row.id, role="user", content=payload.message)
    db.add(user_message)
    db.flush()

    selected_provider = groq_service.selected_provider(payload.provider)
    selected_model = groq_service.selected_model(payload.model or chat_row.model, provider=selected_provider, web_search=False)
    selected_model_payload = model_payload(selected_provider, selected_model)

    if payload.mode in {"deep_research", "multi_model"}:
        research_result = deep_research_service.run(
            messages,
            payload=payload,
            user_id=current_user.id,
        )
        content = web_search_service.ensure_citations(research_result.content, search_bundle)
        content = clean_model_output(content)
        assistant_message = Message(
            chat_id=chat_row.id,
            role="assistant",
            content=content,
            token_count=research_result.usage.get("completion_tokens", 0),
            message_metadata={
                **search_payload(search_bundle),
                **deep_research_payload(research_result.metadata),
            },
        )
        chat_row.model = research_result.selected_model
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
        record_usage(db, current_user.id, "deep_research", research_result.selected_model, research_result.usage)
        db.commit()
        db.refresh(chat_row)
        db.refresh(assistant_message)
        return ChatResponse(chat=ChatRead.model_validate(chat_row), assistant_message=assistant_message)

    if is_model_identity_question(payload.message):
        content = model_identity_answer(selected_provider, selected_model)
        assistant_message = Message(
            chat_id=chat_row.id,
            role="assistant",
            content=content,
            token_count=0,
            message_metadata={
                **search_payload(search_bundle),
                **selected_model_payload,
            },
        )
        chat_row.model = selected_model
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
        record_usage(db, current_user.id, "chat_identity", selected_model, {})
        db.commit()
        db.refresh(chat_row)
        db.refresh(assistant_message)
        return ChatResponse(chat=ChatRead.model_validate(chat_row), assistant_message=assistant_message)

    content, usage, selected_model = groq_service.complete(
        messages,
        model=selected_model,
        provider=selected_provider,
        web_search=False,
        allow_bedrock_fallback=selected_provider != "bedrock",
    )
    content = clean_model_output(content)
    content = web_search_service.ensure_citations(content, search_bundle)
    assistant_message = Message(
        chat_id=chat_row.id,
        role="assistant",
        content=content,
        token_count=usage.get("completion_tokens", 0),
        message_metadata={
            **search_payload(search_bundle),
            **model_payload(selected_provider, selected_model),
        },
    )
    chat_row.model = selected_model
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
    enforce_plan_and_feature_access(
        db,
        current_user,
        mode=payload.mode,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        max_models=payload.max_models,
    )
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
    user_message = Message(chat_id=chat_row.id, role="user", content=payload.message)
    db.add(user_message)
    model_name = payload.model or chat_row.model
    selected_provider = groq_service.selected_provider(payload.provider)
    selected_model = groq_service.selected_model(
        model_name,
        provider=selected_provider,
        web_search=False,
    )
    selected_model_payload = model_payload(selected_provider, selected_model)
    messages = build_messages(
        chat_row,
        payload.message,
        documents,
        system_prompt=payload.system_prompt,
        reasoning=payload.reasoning,
        adaptive_context=prepared_context["prompt_context"],
        runtime_identity=runtime_identity_prompt(payload.provider, selected_model, mode=payload.mode),
    )
    chat_row.model = selected_model
    chat_row.updated_at = datetime.utcnow()
    db.flush()
    user_message_id = user_message.id
    db.commit()

    if payload.mode == "normal" and is_model_identity_question(payload.message):
        chat_id = chat_row.id
        user_id = current_user.id
        content = model_identity_answer(selected_provider, selected_model)

        def identity_event_generator():
            yield f"data: {json.dumps({'type': 'meta', 'chat_id': chat_id, 'model': selected_model_payload['model']})}\n\n"
            yield f"data: {json.dumps({'type': 'delta', 'delta': content})}\n\n"
            with SessionLocal() as stream_db:
                message = Message(
                    chat_id=chat_id,
                    role="assistant",
                    content=content,
                    token_count=0,
                    message_metadata=selected_model_payload,
                )
                chat_record = stream_db.get(Chat, chat_id)
                if chat_record:
                    chat_record.model = selected_model
                    chat_record.updated_at = datetime.utcnow()
                stream_db.add(message)
                stream_db.flush()
                meta_cognition_layer.complete_turn(
                    stream_db,
                    user_id=user_id,
                    chat_id=chat_id,
                    user_message=payload.message,
                    prepared=prepared_context,
                    user_message_id=user_message_id,
                    assistant_message_id=message.id,
                )
                record_usage(stream_db, user_id, "chat_identity_stream", selected_model, {})
                stream_db.commit()
                stream_db.refresh(message)
                yield f"data: {json.dumps({'type': 'done', 'message_id': message.id})}\n\n"

        return StreamingResponse(identity_event_generator(), media_type="text/event-stream")

    if payload.mode in {"deep_research", "multi_model"}:
        chat_id = chat_row.id
        user_id = current_user.id
        search_mode = SearchAgent.effective_mode(payload.search_mode, payload.web_search)

        def deep_event_generator():
            yield f"data: {json.dumps({'type': 'meta', 'chat_id': chat_id})}\n\n"
            try:
                search_bundle: SearchResultBundle | None = None
                model_messages = messages
                should_search, _ = SearchAgent.should_search(payload.message, search_mode)
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

                research_result = deep_research_service.run(
                    model_messages,
                    payload=payload,
                    user_id=user_id,
                )
                final_content = web_search_service.ensure_citations(research_result.content, search_bundle)
                final_content = clean_model_output(final_content)
                yield f"data: {json.dumps({'type': 'delta', 'delta': final_content})}\n\n"

                with SessionLocal() as stream_db:
                    message = Message(
                        chat_id=chat_id,
                        role="assistant",
                        content=final_content,
                        token_count=research_result.usage.get("completion_tokens", 0),
                        message_metadata={
                            **search_payload(search_bundle),
                            **deep_research_payload(research_result.metadata),
                        },
                    )
                    chat_record = stream_db.get(Chat, chat_id)
                    if chat_record:
                        chat_record.model = research_result.selected_model
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
                    record_usage(stream_db, user_id, "deep_research_stream", research_result.selected_model, research_result.usage)
                    stream_db.commit()
                    stream_db.refresh(message)
                    yield f"data: {json.dumps({'type': 'done', 'message_id': message.id})}\n\n"
            except Exception as exc:
                detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
                yield f"data: {json.dumps({'type': 'error', 'detail': detail})}\n\n"

        return StreamingResponse(deep_event_generator(), media_type="text/event-stream")

    chat_id = chat_row.id
    user_id = current_user.id
    search_mode = SearchAgent.effective_mode(payload.search_mode, payload.web_search)

    def event_generator():
        raw_content = ""
        visible_content = ""
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        yield f"data: {json.dumps({'type': 'meta', 'chat_id': chat_id, 'model': selected_model_payload['model']})}\n\n"

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
                model=selected_model,
                provider=selected_provider,
                web_search=False,
                allow_bedrock_fallback=selected_provider != "bedrock",
            )
            for chunk in stream:
                delta = groq_service.extract_stream_delta(chunk)
                chunk_usage = groq_service.extract_usage(chunk)
                if chunk_usage["total_tokens"]:
                    usage = chunk_usage
                if delta:
                    raw_content += delta
                    next_visible = clean_model_output(raw_content)
                    visible_delta = (
                        next_visible[len(visible_content) :]
                        if next_visible.startswith(visible_content)
                        else next_visible
                    )
                    visible_content = next_visible
                    if visible_delta:
                        yield f"data: {json.dumps({'type': 'delta', 'delta': visible_delta})}\n\n"

            final_content = web_search_service.ensure_citations(clean_model_output(raw_content), search_bundle)
            existing_content = visible_content
            citation_delta = final_content[len(existing_content) :]
            if citation_delta:
                visible_content = final_content
                yield f"data: {json.dumps({'type': 'delta', 'delta': citation_delta})}\n\n"

            with SessionLocal() as stream_db:
                message = Message(
                    chat_id=chat_id,
                    role="assistant",
                    content=visible_content,
                    token_count=usage.get("completion_tokens", 0),
                    message_metadata={
                        **search_payload(search_bundle),
                        **selected_model_payload,
                    },
                )
                chat_record = stream_db.get(Chat, chat_id)
                if chat_record:
                    chat_record.model = selected_model
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
