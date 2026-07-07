import base64
import hashlib
import json
from datetime import datetime
from pathlib import Path

from cryptography.fernet import Fernet
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.live import LiveMessage, LiveSession, VisionFrame
from app.models.user import User
from app.schemas.live import (
    LiveMessageRequest,
    LiveMessageResponse,
    LiveSessionEndRequest,
    LiveSessionEndResponse,
    LiveSessionStartResponse,
    VisionAnalyzeResponse,
)
from app.services.admin_control import enforce_user_quota, infer_provider_from_model
from app.services.groq_service import groq_service


router = APIRouter(prefix="/live", tags=["live"])


def session_for_user(db: Session, session_id: str, user_id: str) -> LiveSession:
    session = db.scalar(select(LiveSession).where(LiveSession.id == session_id, LiveSession.user_id == user_id))
    if not session:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Live session not found")
    return session


def selected_text_model(provider: str | None, model: str | None) -> tuple[str, str]:
    selected_provider = groq_service.selected_provider(provider)
    selected_model = groq_service.selected_model(model, provider=selected_provider, web_search=False)
    return selected_provider, selected_model


def live_system_prompt(language: str | None) -> str:
    lang_hint = language or "auto"
    return (
        "You are Auto-AI in live voice mode. Reply naturally for spoken conversation. "
        "Keep responses concise unless the user asks for detail. Support Hindi, English, and Hinglish. "
        "Use soft language for emotion or intent cues; do not claim sensitive traits. "
        f"User language preference/detection hint: {lang_hint}."
    )


def encrypted_payload(value: dict) -> str:
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.jwt_secret_key.encode("utf-8")).digest())
    return Fernet(key).encrypt(json.dumps(value, separators=(",", ":")).encode("utf-8")).decode("ascii")


def validate_image_upload(file: UploadFile, data: bytes) -> str:
    extension = Path(file.filename or "").suffix.lower()
    if extension not in settings.ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Supported image formats are PNG, JPG, JPEG, WEBP, and GIF.",
        )
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded image is empty.")
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image exceeds {settings.MAX_UPLOAD_MB} MB.",
        )
    return extension


@router.post("/session/start", response_model=LiveSessionStartResponse)
def start_live_session(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveSessionStartResponse:
    session = LiveSession(user_id=current_user.id, status="active")
    db.add(session)
    db.commit()
    db.refresh(session)
    return LiveSessionStartResponse(session_id=session.id, status=session.status, started_at=session.started_at)


@router.post("/message", response_model=LiveMessageResponse)
def live_message(
    payload: LiveMessageRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveMessageResponse:
    session = session_for_user(db, payload.session_id, current_user.id)
    if session.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Live session is not active")
    transcript = payload.transcript.strip()
    if not transcript and not payload.image_frame_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Transcript or image frame is required")

    visual_context = ""
    if payload.image_frame_id:
        frame = db.scalar(
            select(VisionFrame).where(
                VisionFrame.id == payload.image_frame_id,
                VisionFrame.session_id == session.id,
                VisionFrame.user_id == current_user.id,
            )
        )
        if not frame:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vision frame not found")
        visual_context = frame.analysis_summary

    selected_provider, selected_model = selected_text_model(payload.provider, payload.model)
    messages = [
        {"role": "system", "content": live_system_prompt(payload.language)},
    ]
    if visual_context:
        messages.append({"role": "system", "content": f"Current visual context:\n{visual_context}"})
    messages.append({"role": "user", "content": transcript or "Explain what you can see."})
    enforce_user_quota(db, current_user, estimated_input_tokens=max(1, len(json.dumps(messages)) // 4))

    content, usage, used_model = groq_service.complete(
        messages,
        model=selected_model,
        provider=selected_provider,
        web_search=False,
        allow_bedrock_fallback=True,
    )
    response_text = content.strip()
    message = LiveMessage(
        session_id=session.id,
        user_id=current_user.id,
        role="assistant",
        transcript=transcript,
        response_text=response_text,
    )
    db.add(message)
    from app.models.api_usage import APIUsage

    input_tokens = int(usage.get("prompt_tokens", usage.get("input_tokens", 0)) or max(1, len(json.dumps(messages)) // 4))
    output_tokens = int(usage.get("completion_tokens", usage.get("output_tokens", 0)) or max(1, len(response_text) // 4))
    db.add(
        APIUsage(
            user_id=current_user.id,
            endpoint="live_message",
            provider=infer_provider_from_model(used_model),
            model=used_model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )
    )
    db.commit()
    db.refresh(message)
    return LiveMessageResponse(session_id=session.id, message_id=message.id, response_text=response_text, model=used_model)


@router.post("/vision/analyze", response_model=VisionAnalyzeResponse)
async def analyze_live_vision(
    session_id: str = Form(...),
    prompt: str = Form("Analyze what is visible and explain it clearly."),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> VisionAnalyzeResponse:
    session = session_for_user(db, session_id, current_user.id)
    if session.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Live session is not active")
    data = await file.read()
    extension = validate_image_upload(file, data)
    enforce_user_quota(db, current_user, estimated_input_tokens=max(1, len(prompt) // 4))

    frame_id = ""
    frame = VisionFrame(session_id=session.id, user_id=current_user.id, image_url="", analysis_summary="")
    db.add(frame)
    db.flush()
    frame_id = frame.id
    frame_dir = Path(settings.UPLOAD_DIR) / "vision_frames" / current_user.id
    frame_dir.mkdir(parents=True, exist_ok=True)
    file_name = f"{frame_id}{extension}"
    frame_path = frame_dir / file_name
    frame_path.write_bytes(data)

    analysis = groq_service.analyze_image(data, file.filename or file_name, prompt).strip()
    frame.image_url = f"/uploads/vision_frames/{current_user.id}/{file_name}"
    frame.analysis_summary = analysis
    db.add(frame)
    db.commit()
    return VisionAnalyzeResponse(
        frame_id=frame_id,
        analysis_summary=analysis,
        image_url=frame.image_url,
        model=settings.GROQ_VISION_MODEL,
    )


@router.post("/session/end", response_model=LiveSessionEndResponse)
def end_live_session(
    payload: LiveSessionEndRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveSessionEndResponse:
    session = session_for_user(db, payload.session_id, current_user.id)
    session.status = "ended"
    session.ended_at = datetime.utcnow()
    db.add(session)
    db.commit()
    db.refresh(session)
    return LiveSessionEndResponse(session_id=session.id, status=session.status, ended_at=session.ended_at or datetime.utcnow())
