import asyncio
import json
import logging
import re
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.api_usage import APIUsage
from app.models.chat import Chat
from app.models.chat_generation import ChatGeneration
from app.models.document import Document
from app.models.message import Message
from app.models.library_asset import LibraryAsset
from app.models.search import SearchRun
from app.models.user import User
from app.schemas.chat import (
    ChatGenerationRead,
    ChatRead,
    ChatRequest,
    ChatResponse,
    CodeAssistRequest,
    CodeAssistResponse,
    ResearchModelOptions,
)
from app.schemas.search import SearchResultBundle
from app.services.admin_control import (
    billable_usage,
    enforce_plan_and_feature_access,
    enforce_user_quota,
    infer_provider_from_model,
    intelligence_mode_access,
    record_usage_log,
    track_quota_usage,
)
from app.services.deep_research import deep_research_service
from app.services.document_service import document_service
from app.services.groq_service import groq_service
from app.services.chat_storage import sync_chat_history, sync_chat_message, sync_chat_session
from app.services.human import AUTO_AI_HUMAN_MODE_PROMPT, meta_cognition_layer
from app.services.live_context import LiveRequestContext, is_time_query
from app.services.orchestration import intelligence_orchestrator
from app.services.orchestration.activity_store import activity_store
from app.services.orchestration.model_registry import model_registry
from app.services.orchestration.preset_policy import coding_configuration_status, coding_model_ids
from app.services.orchestration.schemas import IntelligenceMode
from app.services.preset_detection import CODING_SYSTEM_INSTRUCTION, resolve_preset
from app.services.library_storage import library_storage
from app.services.response_cache import response_cache
from app.services.web_search import SearchAgent, web_search_service


router = APIRouter(prefix="/ai", tags=["ai"])
generation_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="chat-generation")
logger = logging.getLogger("auto_ai.chat_generation")


def public_ai_error(exc: Exception) -> str:
    if isinstance(exc, HTTPException) and exc.status_code < 500:
        return str(exc.detail)
    return "The AI provider is temporarily unavailable. Please retry."


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
    if not title:
        return "New chat"
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

    provider, model = effective_provider_model(payload.provider, payload.model)
    chat = Chat(
        user_id=current_user.id,
        title=payload.title or title_from_message(payload.message),
        system_prompt=payload.system_prompt,
        model=model or settings.chat_model_for(provider),
        mode=payload.mode,
    )
    db.add(chat)
    db.commit()
    db.refresh(chat)
    sync_chat_session(db, chat)
    db.commit()
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
    hidden_attachment_context: str | None = None,
    runtime_identity: str | None = None,
    history_messages: list[Message] | None = None,
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
    if chat.mode == "coding":
        base_prompt += "\n\n" + CODING_SYSTEM_INSTRUCTION

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
                    "The user uploaded document or code content for this turn. Analyze it like a strong document assistant: "
                    "answer the request directly, identify the file structure, extract important facts, explain relevant sections, "
                    "preserve exact code and values, and mention uncertainty or missing content. If the answer is not in the files, say so clearly.\n\n"
                    f"{document_context}"
                ),
            }
        )
    if search_context:
        messages.append({"role": "system", "content": search_context})
    if hidden_attachment_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "The user attached images, files, documents, or code for this turn. Use the extracted context as source material and respond like a high-quality multimodal assistant. "
                    "Start with the direct answer, then provide a useful structured analysis: identify the content, summarize it, extract exact visible text or values, explain relevant details, and give practical next steps when applicable. "
                    "For screenshots, explain the visible UI state and errors. For code, preserve syntax and review correctness and security. Never invent missing details. "
                    "Do not reveal internal extraction notes or claim that hidden context was shown to you.\n\n"
                    f"{hidden_attachment_context}"
                ),
            }
        )

    source_history = history_messages if history_messages is not None else (chat.messages or [])
    history = source_history[-settings.MAX_CONTEXT_MESSAGES :]
    messages.extend({"role": msg.role, "content": msg.content} for msg in history)
    messages.append({"role": "user", "content": user_message or user_message_fallback(hidden_attachment_context)})
    return messages


def apply_preset_resolution(payload: ChatRequest, chat: Chat | None = None) -> None:
    explicit_preset = bool(
        {"preset_mode", "preset_source", "selected_preset", "detected_preset", "manual_preset_locked"}
        & payload.model_fields_set
    )
    if not explicit_preset and "mode" in payload.model_fields_set:
        preset_mode, selected_preset, manual_locked = "manual", payload.mode, True
    elif not explicit_preset and chat is not None:
        preset_mode = chat.preset_mode
        selected_preset = chat.selected_preset
        manual_locked = chat.manual_preset_locked
    else:
        preset_mode = payload.preset_mode
        selected_preset = payload.selected_preset
        manual_locked = payload.manual_preset_locked
    resolution = resolve_preset(
        message=payload.message,
        preset_mode=preset_mode,
        selected_preset=selected_preset,
        manual_preset_locked=manual_locked,
        has_attachments=bool(payload.attachments or payload.document_ids),
    )
    payload.preset_mode = resolution.preset_mode
    payload.preset_source = resolution.preset_source
    payload.selected_preset = resolution.selected_preset
    payload.detected_preset = resolution.detected_preset
    payload.manual_preset_locked = resolution.manual_preset_locked
    payload.mode = resolution.selected_preset
    if chat is not None:
        chat.mode = resolution.selected_preset
        chat.preset_mode = resolution.preset_mode
        chat.selected_preset = resolution.selected_preset
        chat.manual_preset_locked = resolution.manual_preset_locked
    logger.info(
        "preset_resolved presetMode=%s presetSource=%s selectedPreset=%s detectedPreset=%s "
        "manualPresetLocked=%s selectedModel=%s chatId=%s requestId=%s",
        payload.preset_mode, payload.preset_source, payload.selected_preset, payload.detected_preset,
        payload.manual_preset_locked, payload.model, payload.chat_id or (chat.id if chat else None),
        payload.request_id or payload.client_message_id,
    )


def user_message_fallback(hidden_attachment_context: str | None = None) -> str:
    return "Analyze the attached content comprehensively and explain all important details." if hidden_attachment_context else "Continue."


def library_asset_context(db: Session, user_id: str, payload: ChatRequest) -> str:
    if not payload.library_asset_ids:
        return ""
    assets = list(
        db.scalars(
            select(LibraryAsset).where(
                LibraryAsset.user_id == user_id,
                LibraryAsset.id.in_(payload.library_asset_ids),
                LibraryAsset.is_deleted.is_(False),
            )
        )
    )
    if len(assets) != len(set(payload.library_asset_ids)):
        raise HTTPException(status_code=404, detail="Library asset is no longer available.")
    chunks: list[str] = []
    for asset in assets:
        if asset.extracted_text:
            chunks.append(f"Library file: {asset.display_name}\n{asset.extracted_text[:settings.MAX_DOCUMENT_CONTEXT_CHARS]}")
        elif asset.file_type == "image":
            try:
                summary = groq_service.analyze_image(
                    library_storage.read(asset.storage_key),
                    asset.display_name,
                    "Analyze this image comprehensively for an AI chat. Identify the image or screenshot type, describe the full scene and layout, list important objects and UI elements, transcribe every readable word and number accurately, explain visible errors or warnings, and connect the findings to likely user questions. Do not invent unclear details.",
                )
                asset.extracted_text = summary[: settings.MAX_DOCUMENT_CONTEXT_CHARS]
                chunks.append(f"Library image: {asset.display_name}\n{asset.extracted_text}")
            except Exception:
                chunks.append(f"Library image attached: {asset.display_name} ({asset.mime_type})")
        asset.last_used_at = datetime.utcnow()
    db.flush()
    return "\n\n".join(chunks)


def request_hidden_attachment_context(payload: ChatRequest, library_context: str = "") -> str:
    parts: list[str] = []
    if payload.attachments:
        attachment_lines = []
        for attachment in payload.attachments:
            size = f", {attachment.file_size} bytes" if attachment.file_size is not None else ""
            mime = f", {attachment.mime_type}" if attachment.mime_type else ""
            attachment_lines.append(f"- {attachment.type}: {attachment.filename}{mime}{size}")
        parts.append("Attachments:\n" + "\n".join(attachment_lines))
    if payload.internal_context:
        context = payload.internal_context
        if context.image_summary:
            parts.append(f"Image summary:\n{context.image_summary}")
        if context.ocr_text:
            parts.append(f"OCR text:\n{context.ocr_text}")
        if context.parsed_file_text:
            parts.append(f"Parsed file text:\n{context.parsed_file_text}")
    if library_context:
        parts.append(library_context)
    return "\n\n".join(part.strip() for part in parts if part.strip())


def message_metadata_for_request(payload: ChatRequest) -> dict:
    metadata: dict = {
        "presetMode": payload.preset_mode,
        "presetSource": payload.preset_source,
        "selectedPreset": payload.selected_preset,
        "detectedPreset": payload.detected_preset,
        "manualPresetLocked": payload.manual_preset_locked,
        "selectedModel": payload.model,
        "requestId": payload.request_id or payload.client_message_id,
    }
    if payload.client_message_id:
        metadata["client_message_id"] = payload.client_message_id
    if payload.attachments:
        metadata["attachments"] = [attachment.model_dump(mode="json") for attachment in payload.attachments]
    if payload.internal_context:
        metadata["internal_context"] = payload.internal_context.model_dump(mode="json", exclude_none=True)
    return metadata


def initial_streaming_phase(payload: ChatRequest) -> str:
    if payload.mode in {"deep_research", "multi_model"} or payload.search_mode in {"deep", "research"}:
        return "researching"
    if any(attachment.type == "image" for attachment in payload.attachments):
        return "analyzing_image"
    if payload.document_ids or any(attachment.type == "file" for attachment in payload.attachments):
        return "reading_file"
    return "thinking"


def search_payload(bundle: SearchResultBundle | None) -> dict:
    if not bundle or not bundle.searched:
        return {}
    return {"search": bundle.model_dump(mode="json")}


def deep_research_payload(metadata: dict | None) -> dict:
    return {"orchestration": metadata, "deep_research": metadata} if metadata else {}


def model_payload(provider: str, model: str) -> dict:
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI", "gemini": "Gemini"}.get(provider, provider)
    return {"model": {"provider": provider, "provider_label": provider_name, "model": model}}


def clean_model_output(content: str) -> str:
    without_closed_thoughts = THINK_BLOCK_PATTERN.sub("", content)
    return OPEN_THINK_BLOCK_PATTERN.sub("", without_closed_thoughts).strip()


def is_model_identity_question(message: str) -> bool:
    return bool(MODEL_IDENTITY_PATTERN.search(message.strip()))


def model_identity_answer(provider: str, model: str) -> str:
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI", "gemini": "Gemini"}[provider]
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
    *,
    latency_ms: int = 0,
    cache_status: str = "not_applicable",
    error_code: str | None = None,
) -> None:
    provider = infer_provider_from_model(model)
    charged_usage = billable_usage()
    input_tokens = charged_usage["prompt_tokens"]
    output_tokens = charged_usage["completion_tokens"]
    total_tokens = charged_usage["total_tokens"]
    db.add(
        APIUsage(
            user_id=user_id,
            endpoint=endpoint,
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            total_tokens=total_tokens,
            latency_ms=max(0, latency_ms),
            cache_status=cache_status,
            error_code=error_code,
        )
    )
    normalized_usage = {
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": total_tokens,
    }
    record_usage_log(db, user_id, endpoint, model, normalized_usage)
    track_quota_usage(db, user_id, total_tokens)


def estimate_text_tokens(value: str | None) -> int:
    if not value:
        return 0
    return max(1, (len(value) + 3) // 4)


def estimate_message_tokens(messages: list[dict[str, str]]) -> int:
    return sum(estimate_text_tokens(message.get("content")) for message in messages)


def usage_with_estimate(
    usage: dict[str, int],
    *,
    messages: list[dict[str, str]] | None = None,
    output: str = "",
) -> dict[str, int]:
    input_tokens = int(usage.get("input_tokens", usage.get("prompt_tokens", 0)) or 0)
    output_tokens = int(usage.get("output_tokens", usage.get("completion_tokens", 0)) or 0)
    total_tokens = int(usage.get("total_tokens", input_tokens + output_tokens) or 0)
    if total_tokens > 0:
        return {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": total_tokens,
        }
    input_tokens = input_tokens or estimate_message_tokens(messages or [])
    output_tokens = output_tokens or estimate_text_tokens(output)
    return {
        "prompt_tokens": input_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
    }


def runtime_identity_prompt(provider: str | None, model: str | None, *, mode: str) -> str:
    if mode in {"deep_research", "multi_model"}:
        return (
            "Runtime identity: You are Auto-AI using Deep Research / Multi-Model mode. "
            "If the user asks which model is being used, say this mode consults the selected Groq, Bedrock, OpenAI, and Gemini research models and synthesizes one answer. "
            "Do not claim to be ChatGPT, GPT-4, or any other unrelated model."
        )

    selected_provider = groq_service.selected_provider(provider)
    selected_model = groq_service.selected_model(model, provider=selected_provider, web_search=False)
    provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI", "gemini": "Gemini"}[selected_provider]
    return (
        f"Runtime identity: You are Auto-AI using provider {provider_name} with model id {selected_model} for this request. "
        f"If the user asks your model name or architecture, answer exactly with {provider_name} / {selected_model}. "
        "Do not claim to be ChatGPT, GPT-4, Claude, or another model unless that is the selected model id/provider. "
        "Never output hidden reasoning, scratchpad text, or <think> blocks."
    )


RUNNING_GENERATION_STATUSES = {"pending", "running", "cancel_requested"}
TERMINAL_GENERATION_STATUSES = {"completed", "failed", "cancelled"}
STALE_CLIENT_DEFAULT_PROVIDER = "groq"
STALE_CLIENT_DEFAULT_MODEL = "openai/gpt-oss-120b"


def effective_provider_model(
    provider: str | None,
    model: str | None,
) -> tuple[str | None, str | None]:
    backend_provider = settings.AI_PROVIDER.lower()
    if (
        provider == STALE_CLIENT_DEFAULT_PROVIDER
        and model == STALE_CLIENT_DEFAULT_MODEL
        and backend_provider != STALE_CLIENT_DEFAULT_PROVIDER
    ):
        return backend_provider, settings.chat_model_for(backend_provider)
    return provider, model


def generation_payload(db: Session, generation: ChatGeneration) -> dict:
    user_message = db.get(Message, generation.user_message_id) if generation.user_message_id else None
    assistant_message = db.get(Message, generation.assistant_message_id) if generation.assistant_message_id else None
    activity_rows = activity_store.list(generation.id, generation.user_id, session=db)
    activity = activity_store.serialize(activity_rows)
    mode = IntelligenceMode.canonical(str((generation.request_payload or {}).get("mode") or "instant")).value
    return {
        "id": generation.id,
        "chat_id": generation.chat_id,
        "user_message_id": generation.user_message_id,
        "assistant_message_id": generation.assistant_message_id,
        "status": generation.status,
        "error": generation.error,
        "user_message": user_message,
        "assistant_message": assistant_message,
        "mode": mode,
        "activity": activity,
        "activity_summary": activity_store.summary(activity_rows),
        "created_at": generation.created_at,
        "updated_at": generation.updated_at,
        "completed_at": generation.completed_at,
    }


def update_generation_message(
    db: Session,
    *,
    generation: ChatGeneration,
    assistant_message: Message,
    content: str,
    status_value: str,
    metadata: dict | None = None,
    error: str | None = None,
    phase: str | None = None,
    completed: bool = False,
) -> None:
    message_metadata = dict(assistant_message.message_metadata or {})
    if metadata:
        message_metadata.update(metadata)
    stream_metadata = dict(message_metadata.get("streaming") or {})
    stream_metadata.update(
        {
            "generation_id": generation.id,
            "status": status_value,
            "partial": status_value not in TERMINAL_GENERATION_STATUSES,
        }
    )
    if phase:
        stream_metadata["phase"] = phase
    elif status_value in TERMINAL_GENERATION_STATUSES:
        stream_metadata.pop("phase", None)
    if error:
        stream_metadata["error"] = error
    else:
        stream_metadata.pop("error", None)

    message_metadata["streaming"] = stream_metadata
    assistant_message.content = content
    assistant_message.message_metadata = message_metadata
    generation.status = status_value
    generation.error = error
    generation.updated_at = datetime.utcnow()
    if completed:
        generation.completed_at = datetime.utcnow()
    chat_record = db.get(Chat, generation.chat_id)
    if chat_record:
        chat_record.updated_at = datetime.utcnow()
        sync_chat_session(db, chat_record)
    sync_chat_message(
        db,
        assistant_message,
        user_id=generation.user_id,
        model=chat_record.model if chat_record else None,
    )
    db.add_all([generation, assistant_message])


def generation_cancel_requested(db: Session, generation: ChatGeneration) -> bool:
    db.refresh(generation)
    return generation.status in {"cancel_requested", "cancelled"}


def cancel_generation_now(db: Session, generation: ChatGeneration) -> None:
    assistant_message = db.get(Message, generation.assistant_message_id) if generation.assistant_message_id else None
    if assistant_message:
        update_generation_message(
            db,
            generation=generation,
            assistant_message=assistant_message,
            content=assistant_message.content,
            status_value="cancelled",
            completed=True,
        )
        return

    generation.status = "cancelled"
    generation.updated_at = datetime.utcnow()
    generation.completed_at = datetime.utcnow()
    db.add(generation)


def complete_identity_generation(
    db: Session,
    *,
    generation: ChatGeneration,
    payload: ChatRequest,
    user_message_id: str,
    assistant_message: Message,
    prepared_context: dict,
    selected_provider: str,
    selected_model: str,
    selected_model_payload: dict,
) -> None:
    content = model_identity_answer(selected_provider, selected_model)
    update_generation_message(
        db,
        generation=generation,
        assistant_message=assistant_message,
        content=content,
        status_value="completed",
        metadata=selected_model_payload,
        completed=True,
    )
    meta_cognition_layer.complete_turn(
        db,
        user_id=generation.user_id,
        chat_id=generation.chat_id,
        user_message=payload.message,
        prepared=prepared_context,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message.id,
    )
    record_usage(db, generation.user_id, "chat_identity_background", selected_model, {})
    db.commit()


def run_chat_generation(generation_id: str) -> None:
    with SessionLocal() as db:
        generation = db.get(ChatGeneration, generation_id)
        if not generation or generation.status not in RUNNING_GENERATION_STATUSES:
            return

        assistant_message = db.get(Message, generation.assistant_message_id) if generation.assistant_message_id else None
        if not assistant_message:
            generation.status = "failed"
            generation.error = "Assistant message was not found."
            generation.completed_at = datetime.utcnow()
            db.commit()
            return

        try:
            payload = ChatRequest.model_validate(generation.request_payload)
            chat_row = db.scalar(
                select(Chat)
                .where(Chat.id == generation.chat_id, Chat.user_id == generation.user_id)
                .options(selectinload(Chat.messages))
            )
            if not chat_row:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found")

            history = [
                message
                for message in (chat_row.messages or [])
                if message.id not in {generation.user_message_id, generation.assistant_message_id}
            ]
            prepared_context = meta_cognition_layer.prepare_context(
                db,
                user_id=generation.user_id,
                chat_id=generation.chat_id,
                user_message=payload.message,
                history=history[-settings.MAX_CONTEXT_MESSAGES :],
            )
            documents = load_documents(db, generation.user_id, payload.document_ids)
            effective_provider, effective_model = effective_provider_model(
                payload.provider,
                payload.model or chat_row.model,
            )
            selected_provider = groq_service.selected_provider(effective_provider)
            selected_model = groq_service.selected_model(
                effective_model,
                provider=selected_provider,
                web_search=False,
            )
            selected_model_payload = model_payload(selected_provider, selected_model)
            live_context = LiveRequestContext.create(payload.user_timezone, payload.user_locale)
            model_messages = build_messages(
                chat_row,
                payload.message,
                documents,
                system_prompt=payload.system_prompt,
                reasoning=payload.reasoning,
                adaptive_context=prepared_context["prompt_context"],
                hidden_attachment_context=request_hidden_attachment_context(
                    payload, library_asset_context(db, generation.user_id, payload)
                ),
                runtime_identity=(
                    runtime_identity_prompt(effective_provider, selected_model, mode=payload.mode)
                    + "\n\n"
                    + live_context.system_prompt()
                ),
                history_messages=history,
            )
            quota_user = db.get(User, generation.user_id)
            if quota_user:
                enforce_user_quota(db, quota_user, estimated_input_tokens=estimate_message_tokens(model_messages))
            chat_row.model = selected_model
            generation.status = "running"
            update_generation_message(
                db,
                generation=generation,
                assistant_message=assistant_message,
                content=assistant_message.content,
                status_value="running",
                metadata=selected_model_payload,
            )
            db.commit()

            if payload.mode == "instant" and is_time_query(payload.message):
                update_generation_message(
                    db,
                    generation=generation,
                    assistant_message=assistant_message,
                    content=live_context.time_answer(),
                    status_value="completed",
                    metadata={**selected_model_payload, "live_context": {"request_id": live_context.request_id}},
                    completed=True,
                )
                meta_cognition_layer.complete_turn(
                    db,
                    user_id=generation.user_id,
                    chat_id=generation.chat_id,
                    user_message=payload.message,
                    prepared=prepared_context,
                    user_message_id=generation.user_message_id or "",
                    assistant_message_id=assistant_message.id,
                )
                db.commit()
                return

            if payload.mode == "instant" and is_model_identity_question(payload.message):
                complete_identity_generation(
                    db,
                    generation=generation,
                    payload=payload,
                    user_message_id=generation.user_message_id or "",
                    assistant_message=assistant_message,
                    prepared_context=prepared_context,
                    selected_provider=selected_provider,
                    selected_model=selected_model,
                    selected_model_payload=selected_model_payload,
                )
                return

            search_bundle: SearchResultBundle | None = None
            search_mode = (
                "deep"
                if payload.mode == "deep_research"
                else SearchAgent.effective_mode(payload.search_mode, payload.web_search)
            )
            should_search, _ = SearchAgent.should_search(payload.message, search_mode)
            should_search = should_search or payload.mode == "deep_research"
            if should_search:
                if generation_cancel_requested(db, generation):
                    update_generation_message(
                        db,
                        generation=generation,
                        assistant_message=assistant_message,
                        content=assistant_message.content,
                        status_value="cancelled",
                        completed=True,
                    )
                    db.commit()
                    return

                update_generation_message(
                    db,
                    generation=generation,
                    assistant_message=assistant_message,
                    content=assistant_message.content,
                    status_value="running",
                    phase="searching",
                )
                db.commit()
                search_bundle = web_search_service.execute(
                    db,
                    user_id=generation.user_id,
                    query=payload.message,
                    mode=search_mode,
                    chat_id=generation.chat_id,
                    message_id=generation.user_message_id,
                )
                if payload.mode == "deep_research" and not search_bundle.sources:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail="Deep Research could not retrieve any verified web sources. Check the configured search provider and retry.",
                    )
                search_context = web_search_service.build_model_context(search_bundle)
                if search_context:
                    model_messages = [
                        *model_messages[:-1],
                        {"role": "system", "content": search_context},
                        model_messages[-1],
                    ]
                update_generation_message(
                    db,
                    generation=generation,
                    assistant_message=assistant_message,
                    content=assistant_message.content,
                    status_value="running",
                    metadata=search_payload(search_bundle),
                )
                db.commit()

            if payload.mode in {"instant", "medium", "high", "deep_research", "coding"}:
                if search_bundle:
                    try:
                        activity_store.emit(
                            generation.id,
                            generation.user_id,
                            "model.progress",
                            {
                                "mode": payload.mode,
                                "stage": "Reviewing sources",
                                "sources_found": len(search_bundle.sources),
                                "sources_reviewed": len(search_bundle.sources),
                                "sources_accepted": len(search_bundle.sources),
                            },
                        )
                    except Exception as activity_error:
                        logger.warning(
                            "orchestration_activity_write_failed request_id=%s event=model.progress error_type=%s",
                            generation.id,
                            type(activity_error).__name__,
                        )

                def emit_activity(event_type: str, event_payload: dict) -> None:
                    try:
                        activity_store.emit(generation.id, generation.user_id, event_type, event_payload)
                    except Exception as activity_error:
                        logger.warning(
                            "orchestration_activity_write_failed request_id=%s event=%s error_type=%s",
                            generation.id,
                            event_type,
                            type(activity_error).__name__,
                        )

                def is_cancelled() -> bool:
                    with SessionLocal() as cancellation_db:
                        row = cancellation_db.get(ChatGeneration, generation.id)
                        return not row or row.status in {"cancel_requested", "cancelled"}

                def persist_synthesis(content: str) -> None:
                    update_generation_message(
                        db,
                        generation=generation,
                        assistant_message=assistant_message,
                        content=clean_model_output(content),
                        status_value="running",
                        metadata=search_payload(search_bundle),
                        phase="synthesizing",
                    )
                    db.commit()

                research_result = intelligence_orchestrator.run(
                    model_messages,
                    mode=payload.mode,
                    emit=emit_activity,
                    cancelled=is_cancelled,
                    evidence=[
                        source.model_dump(mode="json")
                        for source in (search_bundle.sources if search_bundle else [])
                    ],
                    providers=payload.providers,
                    requested_models=[
                        *payload.groq_models,
                        *payload.bedrock_models,
                        *payload.openai_models,
                        *payload.gemini_models,
                    ],
                    max_models=None if payload.all_models else payload.max_models,
                    stream_content=persist_synthesis,
                )
                if generation_cancel_requested(db, generation):
                    update_generation_message(
                        db,
                        generation=generation,
                        assistant_message=assistant_message,
                        content=assistant_message.content,
                        status_value="cancelled",
                        completed=True,
                    )
                    db.commit()
                    return
                final_content = web_search_service.ensure_citations(research_result.content, search_bundle)
                final_content = clean_model_output(final_content)
                chat_row.model = research_result.selected_model
                update_generation_message(
                    db,
                    generation=generation,
                    assistant_message=assistant_message,
                    content=final_content,
                    status_value="completed",
                    metadata={
                        **search_payload(search_bundle),
                        **deep_research_payload(research_result.metadata),
                    },
                    completed=True,
                )
                attach_search_run_to_message(db, search_bundle, assistant_message.id)
                meta_cognition_layer.complete_turn(
                    db,
                    user_id=generation.user_id,
                    chat_id=generation.chat_id,
                    user_message=payload.message,
                    prepared=prepared_context,
                    user_message_id=generation.user_message_id or "",
                    assistant_message_id=assistant_message.id,
                )
                record_usage(
                    db,
                    generation.user_id,
                    f"{payload.mode}_orchestration_background",
                    research_result.selected_model,
                    usage_with_estimate(research_result.usage, messages=model_messages, output=final_content),
                )
                db.commit()
                return

            raw_content = ""
            visible_content = assistant_message.content or ""
            usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            last_persist_at = time.monotonic()
            last_cancel_check_at = 0.0
            last_persisted_length = len(visible_content)

            stream = groq_service.stream(
                model_messages,
                model=selected_model,
                provider=selected_provider,
                web_search=False,
                allow_bedrock_fallback=True,
            )
            for chunk in stream:
                now = time.monotonic()
                if now - last_cancel_check_at >= 0.25:
                    last_cancel_check_at = now
                    if generation_cancel_requested(db, generation):
                        update_generation_message(
                            db,
                            generation=generation,
                            assistant_message=assistant_message,
                            content=visible_content,
                            status_value="cancelled",
                            completed=True,
                        )
                        db.commit()
                        return

                delta = groq_service.extract_stream_delta(chunk)
                chunk_usage = groq_service.extract_usage(chunk)
                if chunk_usage["total_tokens"]:
                    usage = chunk_usage
                if not delta:
                    continue

                raw_content += delta
                next_visible = clean_model_output(raw_content)
                visible_delta = (
                    next_visible[len(visible_content) :]
                    if next_visible.startswith(visible_content)
                    else next_visible
                )
                visible_content = next_visible
                if not visible_delta:
                    continue

                if now - last_persist_at >= 0.2 or len(visible_content) - last_persisted_length >= 320:
                    update_generation_message(
                        db,
                        generation=generation,
                        assistant_message=assistant_message,
                        content=visible_content,
                        status_value="running",
                        metadata={
                            **search_payload(search_bundle),
                            **selected_model_payload,
                        },
                    )
                    db.commit()
                    last_persist_at = now
                    last_persisted_length = len(visible_content)

            final_content = web_search_service.ensure_citations(clean_model_output(raw_content), search_bundle)
            if generation_cancel_requested(db, generation):
                update_generation_message(
                    db,
                    generation=generation,
                    assistant_message=assistant_message,
                    content=visible_content,
                    status_value="cancelled",
                    completed=True,
                )
                db.commit()
                return
            visible_content = final_content
            update_generation_message(
                db,
                generation=generation,
                assistant_message=assistant_message,
                content=visible_content,
                status_value="completed",
                metadata={
                    **search_payload(search_bundle),
                    **selected_model_payload,
                },
                completed=True,
            )
            attach_search_run_to_message(db, search_bundle, assistant_message.id)
            meta_cognition_layer.complete_turn(
                db,
                user_id=generation.user_id,
                chat_id=generation.chat_id,
                user_message=payload.message,
                prepared=prepared_context,
                user_message_id=generation.user_message_id or "",
                assistant_message_id=assistant_message.id,
            )
            record_usage(
                db,
                generation.user_id,
                "chat_background",
                selected_model,
                usage_with_estimate(usage, messages=model_messages, output=visible_content),
            )
            db.commit()
        except Exception as exc:
            detail = public_ai_error(exc)
            logger.exception("Chat generation %s failed error_type=%s", generation_id, type(exc).__name__)
            update_generation_message(
                db,
                generation=generation,
                assistant_message=assistant_message,
                content=assistant_message.content,
                status_value="failed",
                error=str(detail),
                completed=True,
            )
            db.commit()


def submit_chat_generation(generation_id: str) -> None:
    generation_executor.submit(run_chat_generation, generation_id)


@router.get("/research-models", response_model=ResearchModelOptions)
def research_models(_: User = Depends(get_current_user)) -> dict:
    return deep_research_service.model_options()


@router.get("/intelligence/config")
def intelligence_config(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    records = model_registry.refresh()
    healthy = [record for record in records if record.enabled and record.health_status == "healthy"]
    groq = [record for record in healthy if record.provider == "groq"]
    bedrock = [record for record in healthy if record.provider == "bedrock"]
    coding_available, coding_reason = coding_configuration_status(records)
    groq_coding_model, bedrock_coding_model = coding_model_ids(records)

    def mode_config(
        mode: str,
        provider_available: bool,
        description: str,
        *,
        provider_reason: str | None = None,
        **extra: object,
    ) -> dict:
        entitled, reason = intelligence_mode_access(db, current_user, mode)
        unavailable_reason = reason if not entitled else (
            None if provider_available else provider_reason or "No healthy model is currently available."
        )
        return {
            "available": provider_available and entitled,
            "description": description,
            "unavailable_reason": unavailable_reason,
            **extra,
        }

    return {
        "modes": {
            "instant": mode_config("instant", bool(groq), "Fast single-model response"),
            "medium": mode_config("medium", bool(groq), "Balanced parallel intelligence"),
            "high": mode_config(
                "high",
                bool(groq or bedrock),
                "Advanced multi-provider reasoning",
                fallback_message=None if bedrock else "Continuing with available intelligence models.",
            ),
            "deep_research": mode_config(
                "deep_research",
                bool(groq or bedrock) and bool(settings.TAVILY_API_KEY or settings.SERPER_API_KEY),
                "Source-backed comprehensive research",
            ),
            "coding": mode_config(
                "coding",
                coding_available,
                "Groq Qwen implements while Amazon Bedrock Qwen Coder reviews and corrects.",
                provider_reason=coding_reason,
                fallback_message=(
                    f"Groq: {groq_coding_model} · Bedrock: {bedrock_coding_model}"
                    if coding_available
                    else None
                ),
            ),
        },
        "models": [
            {
                "provider": "AWS Bedrock" if record.provider == "bedrock" else record.provider.title(),
                "display_name": record.friendly_name,
                "healthy": record.health_status == "healthy",
                "supported_modes": sorted(mode.value for mode in record.supported_modes),
            }
            for record in records
        ],
        "refreshed": bool(records),
    }


def create_chat_generation(
    payload: ChatRequest,
    current_user: User,
    db: Session,
    *,
    existing_user_message: Message | None = None,
) -> dict:
    payload.mode = IntelligenceMode.canonical(payload.mode).value
    chat_row = get_or_create_chat(db, current_user, payload)
    apply_preset_resolution(payload, chat_row)
    if payload.mode == "deep_research" and payload.search_mode in {"off", "auto"}:
        payload.search_mode = "deep"
    enforce_plan_and_feature_access(
        db,
        current_user,
        mode=payload.mode,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        max_models=payload.max_models,
    )
    current_user.intelligence_mode = payload.mode
    effective_provider, effective_model = effective_provider_model(
        payload.provider,
        payload.model or chat_row.model,
    )
    selected_provider = groq_service.selected_provider(effective_provider)
    selected_model = groq_service.selected_model(
        effective_model,
        provider=selected_provider,
        web_search=False,
    )
    selected_model_payload = model_payload(selected_provider, selected_model)
    if not existing_user_message and payload.client_message_id:
        existing_user_message = next(
            (
                message
                for message in (chat_row.messages or [])
                if message.role == "user"
                and (message.message_metadata or {}).get("client_message_id") == payload.client_message_id
            ),
            None,
        )
        if existing_user_message:
            existing_generation = db.scalar(
                select(ChatGeneration)
                .where(
                    ChatGeneration.chat_id == chat_row.id,
                    ChatGeneration.user_id == current_user.id,
                    ChatGeneration.user_message_id == existing_user_message.id,
                    ChatGeneration.status.in_(RUNNING_GENERATION_STATUSES | {"completed"}),
                )
                .order_by(ChatGeneration.updated_at.desc())
            )
            if existing_generation:
                return generation_payload(db, existing_generation)

    user_message = existing_user_message or Message(
        chat_id=chat_row.id,
        user_id=current_user.id,
        role="user",
        content=payload.message,
        model=selected_model,
        message_metadata=message_metadata_for_request(payload),
    )
    user_message.user_id = user_message.user_id or current_user.id
    user_message.model = user_message.model or selected_model
    if not existing_user_message:
        user_message.message_metadata = message_metadata_for_request(payload)
    assistant_message = Message(
        chat_id=chat_row.id,
        user_id=current_user.id,
        role="assistant",
        content="",
        model=selected_model,
        message_metadata={
            **selected_model_payload,
            **({"client_message_id": payload.client_message_id} if payload.client_message_id else {}),
            "streaming": {
                "status": "pending",
                "partial": True,
                "phase": initial_streaming_phase(payload),
            },
        },
    )
    chat_row.model = selected_model
    chat_row.mode = payload.mode
    chat_row.updated_at = datetime.utcnow()
    db.add_all([chat_row, user_message, assistant_message])
    db.flush()

    generation = ChatGeneration(
        user_id=current_user.id,
        chat_id=chat_row.id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        status="pending",
        request_payload=payload.model_dump(mode="json", by_alias=True),
    )
    db.add(generation)
    db.flush()
    assistant_metadata = dict(assistant_message.message_metadata or {})
    assistant_metadata["streaming"] = {
        "generation_id": generation.id,
        "status": "pending",
        "partial": True,
        "phase": initial_streaming_phase(payload),
    }
    if payload.client_message_id:
        assistant_metadata["client_message_id"] = payload.client_message_id
    assistant_message.message_metadata = assistant_metadata
    sync_chat_session(db, chat_row)
    sync_chat_message(db, user_message, user_id=current_user.id, model=selected_model)
    sync_chat_message(db, assistant_message, user_id=current_user.id, model=selected_model)
    db.commit()
    db.refresh(generation)
    submit_chat_generation(generation.id)
    return generation_payload(db, generation)


@router.post("/chat/generations", response_model=ChatGenerationRead, status_code=status.HTTP_202_ACCEPTED)
def start_chat_generation(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return create_chat_generation(payload, current_user, db)


@router.get("/chat/generations/active", response_model=list[ChatGenerationRead])
def active_chat_generations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    generations = list(
        db.scalars(
            select(ChatGeneration)
            .join(Chat, Chat.id == ChatGeneration.chat_id)
            .where(
                ChatGeneration.user_id == current_user.id,
                Chat.user_id == current_user.id,
                ChatGeneration.status.in_(RUNNING_GENERATION_STATUSES),
            )
            .order_by(ChatGeneration.updated_at.desc())
        )
    )
    return [generation_payload(db, generation) for generation in generations]


@router.get("/chat/generations/{generation_id}", response_model=ChatGenerationRead)
def get_chat_generation(
    generation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    generation = db.scalar(
        select(ChatGeneration).where(
            ChatGeneration.id == generation_id,
            ChatGeneration.user_id == current_user.id,
        )
    )
    if not generation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generation not found")
    return generation_payload(db, generation)


@router.get("/chat/generations/{generation_id}/events")
async def stream_generation_events(
    generation_id: str,
    request: Request,
    after: int = 0,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    generation = db.scalar(
        select(ChatGeneration).where(
            ChatGeneration.id == generation_id,
            ChatGeneration.user_id == current_user.id,
        )
    )
    if not generation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generation not found")

    async def event_generator():
        cursor = max(0, after)
        idle_ticks = 0
        while not await request.is_disconnected():
            events = activity_store.list(generation_id, current_user.id, after=cursor)
            for item in activity_store.serialize(events):
                cursor = max(cursor, int(item.get("sequence", 0)))
                yield f"id: {cursor}\nevent: activity\ndata: {json.dumps(item, separators=(',', ':'))}\n\n"
            with SessionLocal() as stream_db:
                current = stream_db.get(ChatGeneration, generation_id)
                terminal = not current or current.status in TERMINAL_GENERATION_STATUSES
            if terminal and not events:
                return
            idle_ticks += 1
            if idle_ticks % 20 == 0:
                yield ": keep-alive\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.post("/chat/generations/{generation_id}/cancel", response_model=ChatGenerationRead)
def cancel_chat_generation(
    generation_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    generation = db.scalar(
        select(ChatGeneration).where(
            ChatGeneration.id == generation_id,
            ChatGeneration.user_id == current_user.id,
        )
    )
    if not generation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generation not found")
    if generation.status in TERMINAL_GENERATION_STATUSES:
        return generation_payload(db, generation)

    cancel_generation_now(db, generation)
    db.commit()
    db.refresh(generation)
    return generation_payload(db, generation)


@router.post("/chat", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ChatResponse:
    payload.mode = IntelligenceMode.canonical(payload.mode).value
    chat_row = get_or_create_chat(db, current_user, payload)
    apply_preset_resolution(payload, chat_row)
    enforce_plan_and_feature_access(
        db,
        current_user,
        mode=payload.mode,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        max_models=payload.max_models,
    )
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
    effective_provider, effective_model = effective_provider_model(
        payload.provider,
        payload.model or chat_row.model,
    )
    selected_provider = groq_service.selected_provider(effective_provider)
    selected_model = groq_service.selected_model(effective_model, provider=selected_provider, web_search=False)
    selected_model_payload = model_payload(selected_provider, selected_model)
    messages = build_messages(
        chat_row,
        payload.message,
        documents,
        system_prompt=payload.system_prompt,
        reasoning=payload.reasoning,
        adaptive_context=prepared_context["prompt_context"],
        search_context=web_search_service.build_model_context(search_bundle),
        hidden_attachment_context=request_hidden_attachment_context(
            payload, library_asset_context(db, current_user.id, payload)
        ),
        runtime_identity=runtime_identity_prompt(effective_provider, selected_model, mode=payload.mode),
    )
    enforce_user_quota(db, current_user, estimated_input_tokens=estimate_message_tokens(messages))

    user_message = Message(
        chat_id=chat_row.id,
        user_id=current_user.id,
        role="user",
        content=payload.message,
        model=selected_model,
        message_metadata=message_metadata_for_request(payload),
    )
    db.add(user_message)
    db.flush()

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
            user_id=current_user.id,
            role="assistant",
            content=content,
            model=research_result.selected_model,
            token_count=research_result.usage.get("completion_tokens", 0),
            message_metadata={
                **search_payload(search_bundle),
                **deep_research_payload(research_result.metadata),
            },
        )
        chat_row.model = research_result.selected_model
        chat_row.mode = payload.mode
        chat_row.updated_at = datetime.utcnow()
        db.add(assistant_message)
        db.flush()
        sync_chat_session(db, chat_row)
        sync_chat_message(db, user_message, user_id=current_user.id, model=selected_model)
        sync_chat_message(db, assistant_message, user_id=current_user.id, model=research_result.selected_model)
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
        record_usage(
            db,
            current_user.id,
            "deep_research",
            research_result.selected_model,
            usage_with_estimate(research_result.usage, messages=messages, output=content),
        )
        db.commit()
        db.refresh(chat_row)
        db.refresh(assistant_message)
        return ChatResponse(chat=ChatRead.model_validate(chat_row), assistant_message=assistant_message)

    if is_model_identity_question(payload.message):
        content = model_identity_answer(selected_provider, selected_model)
        assistant_message = Message(
            chat_id=chat_row.id,
            user_id=current_user.id,
            role="assistant",
            content=content,
            model=selected_model,
            token_count=0,
            message_metadata={
                **search_payload(search_bundle),
                **selected_model_payload,
            },
        )
        chat_row.model = selected_model
        chat_row.mode = payload.mode
        chat_row.updated_at = datetime.utcnow()
        db.add(assistant_message)
        db.flush()
        sync_chat_session(db, chat_row)
        sync_chat_message(db, user_message, user_id=current_user.id, model=selected_model)
        sync_chat_message(db, assistant_message, user_id=current_user.id, model=selected_model)
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
        record_usage(
            db,
            current_user.id,
            "chat_identity",
            selected_model,
            usage_with_estimate({}, messages=messages, output=content),
        )
        db.commit()
        db.refresh(chat_row)
        db.refresh(assistant_message)
        return ChatResponse(chat=ChatRead.model_validate(chat_row), assistant_message=assistant_message)

    cache_key = response_cache.key(
        user_id=current_user.id,
        provider=selected_provider,
        model=selected_model,
        messages=messages,
        settings_payload={"mode": payload.mode, "reasoning": payload.reasoning, "search": False},
    )
    cached = response_cache.get(cache_key) if search_bundle is None and payload.mode == "normal" else None
    started_at = time.monotonic()
    if cached:
        content = str(cached["content"])
        usage = dict(cached.get("usage") or {})
        selected_model = str(cached.get("model") or selected_model)
        cache_status = "hit"
    else:
        content, usage, selected_model = groq_service.complete(
            messages,
            model=selected_model,
            provider=selected_provider,
            web_search=False,
            allow_bedrock_fallback=True,
        )
        cache_status = "miss" if search_bundle is None and payload.mode == "normal" else "bypass"
        if cache_status == "miss":
            response_cache.set(cache_key, {"content": content, "usage": usage, "model": selected_model})
    latency_ms = int((time.monotonic() - started_at) * 1000)
    content = clean_model_output(content)
    content = web_search_service.ensure_citations(content, search_bundle)
    assistant_message = Message(
        chat_id=chat_row.id,
        user_id=current_user.id,
        role="assistant",
        content=content,
        model=selected_model,
        token_count=usage.get("completion_tokens", 0),
        message_metadata={
            **search_payload(search_bundle),
            **model_payload(selected_provider, selected_model),
        },
    )
    chat_row.model = selected_model
    chat_row.mode = payload.mode
    chat_row.updated_at = datetime.utcnow()
    db.add(assistant_message)
    db.flush()
    sync_chat_session(db, chat_row)
    sync_chat_message(db, user_message, user_id=current_user.id, model=selected_model)
    sync_chat_message(db, assistant_message, user_id=current_user.id, model=selected_model)
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
    record_usage(db, current_user.id, "chat", selected_model, usage_with_estimate(usage, messages=messages, output=content), latency_ms=latency_ms, cache_status=cache_status)
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
    payload.mode = IntelligenceMode.canonical(payload.mode).value
    chat_row = get_or_create_chat(db, current_user, payload)
    apply_preset_resolution(payload, chat_row)
    enforce_plan_and_feature_access(
        db,
        current_user,
        mode=payload.mode,
        web_search=payload.web_search,
        search_mode=payload.search_mode,
        max_models=payload.max_models,
    )
    documents = load_documents(db, current_user.id, payload.document_ids)
    history = chat_row.messages[-settings.MAX_CONTEXT_MESSAGES :] if chat_row.messages else []
    prepared_context = meta_cognition_layer.prepare_context(
        db,
        user_id=current_user.id,
        chat_id=chat_row.id,
        user_message=payload.message,
        history=history,
    )
    user_message = Message(
        chat_id=chat_row.id,
        user_id=current_user.id,
        role="user",
        content=payload.message,
        message_metadata=message_metadata_for_request(payload),
    )
    db.add(user_message)
    effective_provider, effective_model = effective_provider_model(
        payload.provider,
        payload.model or chat_row.model,
    )
    selected_provider = groq_service.selected_provider(effective_provider)
    selected_model = groq_service.selected_model(
        effective_model,
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
        hidden_attachment_context=request_hidden_attachment_context(
            payload, library_asset_context(db, current_user.id, payload)
        ),
        runtime_identity=runtime_identity_prompt(effective_provider, selected_model, mode=payload.mode),
    )
    enforce_user_quota(db, current_user, estimated_input_tokens=estimate_message_tokens(messages))
    chat_row.model = selected_model
    chat_row.mode = payload.mode
    chat_row.updated_at = datetime.utcnow()
    db.flush()
    user_message.model = selected_model
    sync_chat_session(db, chat_row)
    sync_chat_message(db, user_message, user_id=current_user.id, model=selected_model)
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
                    user_id=user_id,
                    role="assistant",
                    content=content,
                    model=selected_model,
                    token_count=0,
                    message_metadata=selected_model_payload,
                )
                chat_record = stream_db.get(Chat, chat_id)
                if chat_record:
                    chat_record.model = selected_model
                    chat_record.updated_at = datetime.utcnow()
                stream_db.add(message)
                stream_db.flush()
                if chat_record:
                    sync_chat_session(stream_db, chat_record)
                sync_chat_message(stream_db, message, user_id=user_id, model=selected_model)
                meta_cognition_layer.complete_turn(
                    stream_db,
                    user_id=user_id,
                    chat_id=chat_id,
                    user_message=payload.message,
                    prepared=prepared_context,
                    user_message_id=user_message_id,
                    assistant_message_id=message.id,
                )
                record_usage(
                    stream_db,
                    user_id,
                    "chat_identity_stream",
                    selected_model,
                    usage_with_estimate({}, messages=messages, output=content),
                )
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
                        user_id=user_id,
                        role="assistant",
                        content=final_content,
                        model=research_result.selected_model,
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
                    if chat_record:
                        sync_chat_session(stream_db, chat_record)
                    sync_chat_message(stream_db, message, user_id=user_id, model=research_result.selected_model)
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
                    record_usage(
                        stream_db,
                        user_id,
                        "deep_research_stream",
                        research_result.selected_model,
                        usage_with_estimate(research_result.usage, messages=model_messages, output=final_content),
                    )
                    stream_db.commit()
                    stream_db.refresh(message)
                    yield f"data: {json.dumps({'type': 'done', 'message_id': message.id})}\n\n"
            except Exception as exc:
                detail = public_ai_error(exc)
                logger.exception("Deep research stream failed request_id=%s error_type=%s", user_message_id, type(exc).__name__)
                yield f"data: {json.dumps({'type': 'error', 'detail': detail, 'request_id': user_message_id})}\n\n"

        return StreamingResponse(deep_event_generator(), media_type="text/event-stream")

    chat_id = chat_row.id
    user_id = current_user.id
    search_mode = SearchAgent.effective_mode(payload.search_mode, payload.web_search)

    def event_generator():
        raw_content = ""
        visible_content = ""
        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        yield f"data: {json.dumps({'type': 'meta', 'chat_id': chat_id, 'model': selected_model_payload['model']})}\n\n"

        started_at = time.monotonic()
        cache_status = "bypass"
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

            cache_key = response_cache.key(user_id=user_id, provider=selected_provider, model=selected_model, messages=model_messages, settings_payload={"mode": payload.mode, "reasoning": payload.reasoning, "search": False})
            can_cache = not should_search and payload.mode == "normal"
            cached = response_cache.get(cache_key) if can_cache else None
            if cached:
                cache_status = "hit"
                raw_content = str(cached["content"])
                visible_content = clean_model_output(raw_content)
                usage = dict(cached.get("usage") or usage)
                yield f"data: {json.dumps({'type': 'delta', 'delta': visible_content})}\n\n"
            else:
                cache_status = "miss" if can_cache else "bypass"
                stream = groq_service.stream(
                    model_messages,
                    model=selected_model,
                    provider=selected_provider,
                    web_search=False,
                    allow_bedrock_fallback=True,
                )
                for chunk in stream:
                    delta = groq_service.extract_stream_delta(chunk)
                    chunk_usage = groq_service.extract_usage(chunk)
                    if chunk_usage["total_tokens"]:
                        usage = chunk_usage
                    if delta:
                        raw_content += delta
                        next_visible = clean_model_output(raw_content)
                        visible_delta = next_visible[len(visible_content) :] if next_visible.startswith(visible_content) else next_visible
                        visible_content = next_visible
                        if visible_delta:
                            yield f"data: {json.dumps({'type': 'delta', 'delta': visible_delta})}\n\n"
                if cache_status == "miss":
                    response_cache.set(cache_key, {"content": visible_content, "usage": usage, "model": selected_model})

            final_content = web_search_service.ensure_citations(clean_model_output(raw_content), search_bundle)
            existing_content = visible_content
            citation_delta = final_content[len(existing_content) :]
            if citation_delta:
                visible_content = final_content
                yield f"data: {json.dumps({'type': 'delta', 'delta': citation_delta})}\n\n"

            with SessionLocal() as stream_db:
                message = Message(
                    chat_id=chat_id,
                    user_id=user_id,
                    role="assistant",
                    content=visible_content,
                    model=selected_model,
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
                if chat_record:
                    sync_chat_session(stream_db, chat_record)
                sync_chat_message(stream_db, message, user_id=user_id, model=selected_model)
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
                record_usage(
                    stream_db,
                    user_id,
                    "chat_stream",
                    selected_model,
                    usage_with_estimate(usage, messages=model_messages, output=visible_content),
                    latency_ms=int((time.monotonic() - started_at) * 1000),
                    cache_status=cache_status,
                )
                stream_db.commit()
                stream_db.refresh(message)
                yield f"data: {json.dumps({'type': 'done', 'message_id': message.id})}\n\n"
        except Exception as exc:
            detail = public_ai_error(exc)
            logger.exception("Chat stream failed request_id=%s error_type=%s", user_message_id, type(exc).__name__)
            yield f"data: {json.dumps({'type': 'error', 'detail': detail, 'request_id': user_message_id})}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/image-analysis")
async def image_analysis(
    file: UploadFile = File(...),
    prompt: str = Form("Analyze this image in detail."),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    enforce_user_quota(db, current_user)
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
        usage_with_estimate({}, messages=[{"role": "user", "content": prompt}], output=content),
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
    enforce_user_quota(db, current_user, estimated_input_tokens=estimate_message_tokens(messages))
    content, usage, selected_model = groq_service.complete(messages, model=payload.model)
    record_usage(db, current_user.id, "code", selected_model, usage_with_estimate(usage, messages=messages, output=content))
    db.commit()
    return CodeAssistResponse(content=content, model=selected_model)
