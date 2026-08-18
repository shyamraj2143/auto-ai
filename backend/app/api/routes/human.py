from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.human import ConversationTurnAnalysis
from app.models.user import User
from app.schemas.human import (
    HumanStateRead,
    InteractionProfileRead,
    MemoryCreate,
    MemoryRead,
    MemoryUpdate,
    TurnAnalysisRead,
)
from app.services.human.emotional_state import emotional_state_manager
from app.services.human.memory_service import long_term_memory_engine
from app.services.personal_model_service import personal_model_service

router = APIRouter(prefix="/human", tags=["human-mode"])

@router.get("/profile", response_model=InteractionProfileRead)
def get_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = emotional_state_manager.get_or_create_profile(db, current_user.id)
    db.commit(); db.refresh(profile)
    return profile

@router.get("/state", response_model=HumanStateRead)
def get_human_state(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = emotional_state_manager.get_or_create_profile(db, current_user.id)
    memories = long_term_memory_engine.list_memories(db, user_id=current_user.id)
    recent_turns = list(db.scalars(select(ConversationTurnAnalysis).where(ConversationTurnAnalysis.user_id == current_user.id).order_by(ConversationTurnAnalysis.created_at.desc()).limit(20)))
    db.commit(); db.refresh(profile)
    return HumanStateRead(profile=profile, memories=memories, recent_turns=recent_turns)

@router.get("/personal-model")
def get_personal_model(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return personal_model_service.snapshot(db, user=current_user)

@router.post("/personal-model/train")
def train_personal_model(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        return personal_model_service.train(db, user=current_user)
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

@router.get("/personal-model/context")
def get_personal_model_context(query: str = Query(default="", max_length=2000), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return {"model": personal_model_service.VERSION, "context": personal_model_service.build_context(db, user=current_user, query=query)}

@router.get("/memories", response_model=list[MemoryRead])
def list_memories(category: str | None = Query(default=None, max_length=80), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return long_term_memory_engine.list_memories(db, user_id=current_user.id, category=category)

@router.post("/memories", response_model=MemoryRead, status_code=status.HTTP_201_CREATED)
def create_memory(payload: MemoryCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return long_term_memory_engine.create_memory(db, user_id=current_user.id, payload=payload.model_dump())

@router.patch("/memories/{memory_id}", response_model=MemoryRead)
def update_memory(memory_id: str, payload: MemoryUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return long_term_memory_engine.update_memory(db, user_id=current_user.id, memory_id=memory_id, updates=payload.model_dump(exclude_unset=True))

@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(memory_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    long_term_memory_engine.delete_memory(db, user_id=current_user.id, memory_id=memory_id)
    return None

@router.delete("/memories", status_code=status.HTTP_204_NO_CONTENT)
def clear_memories(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    long_term_memory_engine.clear_memories(db, user_id=current_user.id)
    return None

@router.get("/turns", response_model=list[TurnAnalysisRead])
def list_turn_analyses(chat_id: str | None = Query(default=None), limit: int = Query(default=50, ge=1, le=200), current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    statement = select(ConversationTurnAnalysis).where(ConversationTurnAnalysis.user_id == current_user.id)
    if chat_id:
        statement = statement.where(ConversationTurnAnalysis.chat_id == chat_id)
    return list(db.scalars(statement.order_by(ConversationTurnAnalysis.created_at.desc()).limit(limit)))
