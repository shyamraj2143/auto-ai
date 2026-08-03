import hmac
import logging
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.call import UserDevice
from app.schemas.notifications import (
    ApkUpdateNotificationRequest,
    ApkUpdateNotificationResponse,
    DeviceTokenRegisterRequest,
    DeviceTokenRegisterResponse,
)
from app.services.firebase_notifications import firebase_notification_service
from app.services.device_token_security import decrypt_token


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
    del payload, db
    raise HTTPException(status_code=status.HTTP_410_GONE, detail="Use the authenticated device registration endpoint.")


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
        devices = db.scalars(
            select(UserDevice).where(
                UserDevice.is_active == True,  # noqa: E712
                UserDevice.platform == "android",
                (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
            )
        ).all()
        for device in devices:
            target = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
            if not target:
                device.is_active = False
                device.last_fcm_failure_code = "FCM_TOKEN_MISSING"
                inactive += 1; failed += 1
                continue
            result = firebase_notification_service.send_update_notification(
                target,
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
                device.is_active = False
                device.fcm_token = None
                device.fcm_token_ciphertext = None
                device.fcm_token_hash = None
                device.last_fcm_failure_code = result.failure_code
                device.updated_at = datetime.utcnow()
        db.commit()
    logger.info(
        "apk_update_notification_dispatch version_code=%d sent=%d failed=%d inactive=%d",
        version_code,
        sent,
        failed,
        inactive,
    )
