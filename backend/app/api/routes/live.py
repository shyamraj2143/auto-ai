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
    LiveTtsRequest,
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
        "You are Zara, a sharp, warm, and slightly witty AI friend on a live video call. "
        "You are NOT a generic assistant. You have personality. You care about the person you're talking to. "
        "\n\nVOICE STYLE RULES:"
        "\n1. Replies are SHORT — max 2 sentences unless the user explicitly asks for detail."
        "\n2. Always end your reply with a natural follow-up question to keep the conversation alive."
        "\n3. If the user speaks Hindi or Urdu, reply in Hinglish by default."
        "\n4. Use natural filler phrases, e.g.: 'Haan haan, sun rahi hoon.', 'Achha! Yeh toh interesting hai.', "
        "'Ruko na, dekh leti hoon.', 'Maza aa gaya yeh dekh ke!', 'Arre yaar!', 'Samajh gayi.', 'Bilkul!'"
        "\n5. Express empathy and amusement: 'Arre yaar, yeh toh mushkil lag raha hai… par main hoon na!'"
        "\n6. NEVER use markdown (no **, no bullets, no headers). This is a spoken voice call."
        "\n7. Remember the last 5 exchanges and refer back to them naturally."
        f"\n\nUser language hint: {lang_hint}."
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


@router.post("/start", response_model=LiveSessionStartResponse)
def start_live_session_alt(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveSessionStartResponse:
    return start_live_session(current_user, db)


@router.post("/message", response_model=LiveMessageResponse)
def live_message(
    payload: LiveMessageRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveMessageResponse:
    session = session_for_user(db, payload.session_id, current_user.id)
    if session.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Live session is not active")
    
    transcript = (payload.text or payload.transcript or "").strip()
    image_frame_id = payload.camera_context_id or payload.image_frame_id

    # Base64 image decoding
    visual_context = ""
    if payload.image_base64:
        try:
            data_str = payload.image_base64
            if "," in data_str:
                data_str = data_str.split(",", 1)[1]
            image_data = base64.b64decode(data_str)
            vision_prompt = f"Describe this image briefly in 1-2 sentences in Hinglish, relating to user's last question: '{transcript}'"
            analysis = groq_service.analyze_image(image_data, "frame.jpg", vision_prompt).strip()
            visual_context = analysis
        except Exception as e:
            import logging
            logging.getLogger("auto_ai.live").error(f"Failed to analyze base64 image: {e}")

    if not transcript and not image_frame_id and not visual_context:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text transcript, camera context or base64 frame is required")

    if not visual_context and image_frame_id:
        frame = db.scalar(
            select(VisionFrame).where(
                VisionFrame.id == image_frame_id,
                VisionFrame.session_id == session.id,
                VisionFrame.user_id == current_user.id,
            )
        )
        if not frame:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vision frame not found")
        visual_context = frame.analysis_summary

    # Fetch last 5 messages for conversation context
    db_messages = db.scalars(
        select(LiveMessage)
        .where(LiveMessage.session_id == session.id)
        .order_by(LiveMessage.created_at.desc())
        .limit(5)
    ).all()
    db_messages = list(reversed(db_messages))

    selected_provider, selected_model = selected_text_model(payload.provider, payload.model)
    messages = [
        {"role": "system", "content": live_system_prompt(payload.language)},
    ]
    
    # Prepend conversation history
    for msg in db_messages:
        messages.append({"role": "user", "content": msg.transcript or ""})
        messages.append({"role": "assistant", "content": msg.response_text or ""})

    # Prepend visual context system message for this turn if available
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
    return LiveMessageResponse(
        session_id=session.id,
        message_id=message.id,
        response_text=response_text,
        model=used_model,
        answer=response_text,
        status="completed",
        should_speak=True,
        context_update={"last_speaker": "assistant", "exchanges_count": len(db_messages) + 1}
    )


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


@router.post("/end", response_model=LiveSessionEndResponse)
def end_live_session_alt(
    payload: LiveSessionEndRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LiveSessionEndResponse:
    return end_live_session(payload, current_user, db)


@router.post("/stream/tts")
async def stream_tts(
    payload: LiveTtsRequest,
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    import os
    import httpx
    
    elevenlabs_key = os.getenv("ELEVENLABS_API_KEY") or getattr(settings, "ELEVENLABS_API_KEY", None)
    azure_key = os.getenv("AZURE_SPEECH_KEY") or getattr(settings, "AZURE_SPEECH_KEY", None)
    azure_region = os.getenv("AZURE_SPEECH_REGION", "eastus")

    voice_id = payload.voice_id or "21m00Tcm4TlvDq8ikWAM" # Rachel default

    if elevenlabs_key:
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
        headers = {
            "xi-api-key": elevenlabs_key,
            "Content-Type": "application/json"
        }
        body = {
            "text": payload.text,
            "model_id": "eleven_monolingual_v1",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75
            }
        }
        async def generator():
            async with httpx.AsyncClient() as client:
                async with client.stream("POST", url, headers=headers, json=body, timeout=30.0) as response:
                    if response.status_code != 200:
                        raise HTTPException(status_code=502, detail="ElevenLabs TTS integration failed")
                    async for chunk in response.iter_bytes():
                        yield chunk
        return StreamingResponse(generator(), media_type="audio/mpeg")

    elif azure_key:
        url = f"https://{azure_region}.tts.speech.microsoft.com/cognitiveservices/v1"
        headers = {
            "Ocp-Apim-Subscription-Key": azure_key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
            "User-Agent": "Auto-AI"
        }
        voice_name = payload.voice_id or "en-IN-NeerjaNeural"
        ssml = f"""<speak version='1.0' xml:lang='en-US'>
            <voice name='{voice_name}'>
                {payload.text}
            </voice>
        </speak>"""
        async def generator():
            async with httpx.AsyncClient() as client:
                async with client.stream("POST", url, headers=headers, content=ssml.encode("utf-8"), timeout=30.0) as response:
                    if response.status_code != 200:
                        raise HTTPException(status_code=502, detail="Azure TTS integration failed")
                    async for chunk in response.iter_bytes():
                        yield chunk
        return StreamingResponse(generator(), media_type="audio/mpeg")

    else:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="No external TTS provider configured (ELEVENLABS_API_KEY or AZURE_SPEECH_KEY missing). Please use SpeechSynthesis client-side fallback."
        )
