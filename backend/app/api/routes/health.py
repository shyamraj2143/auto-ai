from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import get_db


router = APIRouter(tags=["health"])


@router.get("/", include_in_schema=False)
def root():
    """Keep the public Railway backend URL useful when opened directly."""
    return RedirectResponse(url=f"{settings.API_V1_STR}/download/apk", status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/download", include_in_schema=False)
def download_root():
    """Compatibility shortcut for old/public APK download links."""
    return RedirectResponse(url=f"{settings.API_V1_STR}/download/apk", status_code=status.HTTP_307_TEMPORARY_REDIRECT)


@router.get("/health")
def health():
    """Lightweight health endpoint used by Railway.

    This endpoint must never depend on an optional AI provider. AWS Bedrock
    was deactivated for this deployment, so it is intentionally not queried
    here. The health check only reports providers that are still supported by
    the running app.
    """
    provider = settings.AI_PROVIDER.lower()
    configured = {
        "openai": bool(settings.OPENAI_API_KEY),
        "groq": bool(settings.groq_api_key),
        "gemini": bool(settings.GEMINI_API_KEY),
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
