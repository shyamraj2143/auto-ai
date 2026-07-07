import hashlib
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.routes.live import encrypted_payload, validate_image_upload
from app.db.session import get_db
from app.models.live import FaceMemory
from app.models.user import User
from app.schemas.live import FaceMemoryStatusResponse


router = APIRouter(prefix="/memory", tags=["memory"])


@router.get("/face/status", response_model=FaceMemoryStatusResponse)
def face_memory_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FaceMemoryStatusResponse:
    memory = db.scalar(select(FaceMemory).where(FaceMemory.user_id == current_user.id))
    return FaceMemoryStatusResponse(
        enabled=bool(memory and memory.consent_given),
        consent_given=bool(memory and memory.consent_given),
        updated_at=memory.updated_at if memory else None,
    )


@router.post("/face/enroll", response_model=FaceMemoryStatusResponse)
async def enroll_face_memory(
    consent_given: bool = Form(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FaceMemoryStatusResponse:
    if not consent_given:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Face memory requires explicit consent.")
    data = await file.read()
    validate_image_upload(file, data)
    digest = hashlib.sha256(data).hexdigest()
    now = datetime.utcnow()
    encrypted = encrypted_payload(
        {
            "user_id": current_user.id,
            "display_name": current_user.name,
            "image_sha256": digest,
            "created_at": now.isoformat(),
        }
    )
    memory = db.scalar(select(FaceMemory).where(FaceMemory.user_id == current_user.id))
    if memory:
        memory.encrypted_face_embedding = encrypted
        memory.consent_given = True
        memory.updated_at = now
    else:
        memory = FaceMemory(
            user_id=current_user.id,
            encrypted_face_embedding=encrypted,
            consent_given=True,
            created_at=now,
            updated_at=now,
        )
    db.add(memory)
    db.commit()
    db.refresh(memory)
    return FaceMemoryStatusResponse(enabled=True, consent_given=True, updated_at=memory.updated_at)


@router.delete("/face", status_code=status.HTTP_204_NO_CONTENT)
def delete_face_memory(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    memory = db.scalar(select(FaceMemory).where(FaceMemory.user_id == current_user.id))
    if memory:
        db.delete(memory)
        db.commit()
    return None
