from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db


router = APIRouter(tags=["health"])


@router.get("/health")
def health():
    provider = settings.AI_PROVIDER.lower()
    bedrock_configured = bool(
        settings.bedrock_api_key
        or (settings.aws_access_key_id and settings.aws_secret_access_key)
    )
    configured = {
        "openai": bool(settings.OPENAI_API_KEY),
        "groq": bool(settings.groq_api_key),
        "bedrock": bedrock_configured,
    }
    return {
        "status": "ok",
        "service": settings.PROJECT_NAME,
        "environment": settings.ENVIRONMENT,
        "ai_provider": provider,
        "ai_model": settings.default_chat_model,
        "ai_configured": configured.get(provider, False),
        "groq_configured": bool(settings.groq_api_key),
        "openai_configured": bool(settings.OPENAI_API_KEY),
        "bedrock_configured": bedrock_configured,
        "gemini_configured": bool(settings.GEMINI_API_KEY),
        "commit_sha": settings.RAILWAY_GIT_COMMIT_SHA,
        "deployment_id": settings.RAILWAY_DEPLOYMENT_ID,
    }


@router.get("/ready")
def readiness(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Database is not ready.") from exc
    return {"status": "ready", "database": "reachable", "environment": settings.ENVIRONMENT}
