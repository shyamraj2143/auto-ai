from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.user import User
from app.services.groq_service import groq_service


router = APIRouter(prefix="/voice", tags=["voice"])


@router.post("/transcribe")
async def transcribe_voice(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    extension = Path(file.filename or "").suffix.lower()
    if extension not in settings.ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Supported audio formats are FLAC, MP3, M4A, MPEG, MPGA, OGG, WAV, and WEBM.",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded audio is empty.")
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Audio exceeds {settings.MAX_UPLOAD_MB} MB.",
        )
    filename = file.filename or "voice.webm"
    model = (settings.GROQ_TRANSCRIPTION_MODEL or settings.GROQ_ALARM_TRANSCRIPTION_MODEL or settings.GROQ_AUDIO_MODEL) if filename.lower().startswith("alarm.") else settings.GROQ_AUDIO_MODEL
    is_alarm = filename.lower().startswith("alarm.")
    text = groq_service.transcribe_audio(
        data,
        filename,
        model=model,
        language="hi" if is_alarm else None,
        prompt=(
            "यह Hindi या Hinglish में बोला गया alarm command है। तारीख, सुबह, भोर, दोपहर, शाम, रात, "
            "साढ़े, पौने, सवा, office, medicine, exam, daily, snooze और alarm जैसे शब्द ठीक लिखें। अर्थ न बदलें।"
            if is_alarm else None
        ),
    )
    return {"text": text, "model": model}
