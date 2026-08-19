from fastapi import APIRouter, Depends

from app.api.deps import get_current_user
from app.models.user import User
from app.services.self_engine import self_development_engine

router = APIRouter(prefix="/self-engine", tags=["self-engine"])


@router.get("")
def get_self_engine_state(current_user: User = Depends(get_current_user)):
    del current_user
    return self_development_engine.snapshot()


@router.post("/run")
def run_self_engine(current_user: User = Depends(get_current_user)):
    del current_user
    return self_development_engine.run_once()
