import hmac
import logging
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.push import PushDeviceToken
from app.schemas.notifications import (
    ApkUpdateNotificationRequest,
    ApkUpdateNotificationResponse,
    DeviceTokenRegisterRequest,
    DeviceTokenRegisterResponse,
)
from app.services.firebase_notifications import firebase_notification_service


router = APIRouter(prefix="/notifications", tags=["notifications"])
logger = logging.getLogger(__name__)


def notify_secret_value() -> str:
    return settings.UPDATE_NOTIFY_SECRET.get_secret_value() if settings.UPDATE_NOTIFY_SECRET else ""


def require_notify_secret(request: Request) -> None:
    configured = notify_secret_value()
    if not configured:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Update notifications are not configured.")
    provided = request.headers.get("x-auto-ai-notify-secret", "")
    auth = request.headers.get("authorization", "")
    if not provided and auth.lower().startswith("bearer "):
        provided = auth.split(" ", 1)[1].strip()
    if not hmac.compare_digest(provided, configured):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid notification secret.")


@router.post("/device-token", response_model=DeviceTokenRegisterResponse)
def register_device_token(
    payload: DeviceTokenRegisterRequest,
    db: Session = Depends(get_db),
) -> DeviceTokenRegisterResponse:
    now = datetime.utcnow()
    token = db.scalar(select(PushDeviceToken).where(PushDeviceToken.token == payload.token))
    if not token:
        token = PushDeviceToken(token=payload.token)
        db.add(token)
    token.platform = payload.platform or "android"
    token.app_version = payload.app_version
    token.version_code = payload.version_code
    token.is_active = True
    token.last_seen_at = now
    token.updated_at = now
    db.commit()
    return DeviceTokenRegisterResponse(registered=True)


@router.post("/apk-update", response_model=ApkUpdateNotificationResponse)
def notify_apk_update(
    payload: ApkUpdateNotificationRequest,
    request: Request,
    background_tasks: BackgroundTasks,
) -> ApkUpdateNotificationResponse:
    require_notify_secret(request)
    if not firebase_notification_service.configured:
        return ApkUpdateNotificationResponse(skipped=True, detail="Firebase service account is not configured.")

    background_tasks.add_task(
        dispatch_apk_update_notifications,
        payload.version_code,
        payload.version_name,
        payload.changelog,
    )
    return ApkUpdateNotificationResponse(detail="Notification dispatch queued.")


def dispatch_apk_update_notifications(version_code: int, version_name: str, changelog: str | None) -> None:
    sent = 0
    failed = 0
    inactive = 0
    with SessionLocal() as db:
        tokens = db.scalars(
            select(PushDeviceToken).where(
                PushDeviceToken.is_active == True,  # noqa: E712
                PushDeviceToken.platform == "android",
            )
        ).all()
        for token in tokens:
            result = firebase_notification_service.send_update_notification(
                token.token,
                version_code=version_code,
                version_name=version_name,
                changelog=changelog,
            )
            if result.ok:
                sent += 1
                continue
            failed += 1
            if result.inactive:
                inactive += 1
                token.is_active = False
                token.updated_at = datetime.utcnow()
        db.commit()
    logger.info(
        "apk_update_notification_dispatch version_code=%d sent=%d failed=%d inactive=%d",
        version_code,
        sent,
        failed,
        inactive,
    )
