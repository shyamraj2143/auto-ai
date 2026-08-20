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
    """Minimal liveness endpoint used by Railway.

    Keep this endpoint independent of AI providers, credentials, databases,
    and optional integrations. A disabled provider such as AWS Bedrock must
    never be able to make the deployment unhealthy.
    """
    return {
        "status": "ok",
        "service": settings.PROJECT_NAME,
        "environment": settings.ENVIRONMENT,
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
