import hmac
import logging
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.api.deps import get_current_user
from app.core.security import decode_access_token
from app.db.session import SessionLocal, get_db
from app.models.call import UserDevice
from app.models.push import UserNotificationPreference
from app.models.user import User
from app.schemas.notifications import (
    ApkUpdateNotificationRequest,
    ApkUpdateNotificationResponse,
    DeviceTokenRegisterRequest,
    DeviceTokenRegisterResponse,
    NotificationPreferenceRead,
    NotificationPreferenceUpdate,
)
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service


router = APIRouter(prefix="/notifications", tags=["notifications"])
logger = logging.getLogger(__name__)
ADMIN_ROLES = {"admin", "super_admin", "administrator"}


def notification_preferences(db: Session, user_id: str) -> UserNotificationPreference:
    record = db.scalar(select(UserNotificationPreference).where(UserNotificationPreference.user_id == user_id))
    if not record:
        record = UserNotificationPreference(user_id=user_id)
        db.add(record)
        db.flush()
    return record


@router.get("/preferences", response_model=NotificationPreferenceRead)
def get_notification_preferences(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    record = notification_preferences(db, current_user.id)
    db.commit()
    return record


@router.patch("/preferences", response_model=NotificationPreferenceRead)
def update_notification_preferences(payload: NotificationPreferenceUpdate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    record = notification_preferences(db, current_user.id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, key, value)
    record.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(record)
    return record


def notify_secret_value() -> str:
    return settings.UPDATE_NOTIFY_SECRET.get_secret_value() if settings.UPDATE_NOTIFY_SECRET else ""


def authorize_apk_update_notification(request: Request, db: Session) -> str:
    """Allow the dedicated secret or a valid active administrator access token."""
    configured_secret = notify_secret_value()
    provided_secret = request.headers.get("x-auto-ai-notify-secret", "").strip()
    authorization = request.headers.get("authorization", "").strip()
    bearer_token = ""
    if authorization.lower().startswith("bearer "):
        bearer_token = authorization.split(" ", 1)[1].strip()

    if configured_secret:
        if provided_secret and hmac.compare_digest(provided_secret, configured_secret):
            return "notification_secret"
        # Preserve compatibility with older release scripts that supplied the
        # notification secret as a bearer token.
        if bearer_token and hmac.compare_digest(bearer_token, configured_secret):
            return "notification_secret"

    if bearer_token:
        user_id = decode_access_token(bearer_token)
        user = db.get(User, user_id) if user_id else None
        if (
            user
            and user.is_active
            and user.is_admin
            and (user.role or "").lower() in ADMIN_ROLES
            and (user.subscription_status or "").lower() not in {"blocked", "suspended"}
        ):
            return "authenticated_admin"
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator access is required to dispatch application updates.",
        )

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=(
            "Provide the update notification secret or authenticate as an administrator."
            if configured_secret
            else "Authenticate as an administrator to dispatch application updates."
        ),
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/device-token", response_model=DeviceTokenRegisterResponse)
def register_device_token(
    payload: DeviceTokenRegisterRequest,
    db: Session = Depends(get_db),
) -> DeviceTokenRegisterResponse:
    del payload, db
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="Use the authenticated device registration endpoint.",
    )


@router.post("/apk-update", response_model=ApkUpdateNotificationResponse)
def notify_apk_update(
    payload: ApkUpdateNotificationRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> ApkUpdateNotificationResponse:
    authorization_mode = authorize_apk_update_notification(request, db)
    if not firebase_notification_service.configured:
        return ApkUpdateNotificationResponse(
            skipped=True,
            detail="Firebase service account is not configured.",
        )

    background_tasks.add_task(
        dispatch_apk_update_notifications,
        payload.version_code,
        payload.version_name,
        payload.changelog,
    )
    logger.info(
        "apk_update_notification_queued version_code=%d authorization=%s",
        payload.version_code,
        authorization_mode,
    )
    return ApkUpdateNotificationResponse(detail="Notification dispatch queued.")


def dispatch_apk_update_notifications(
    version_code: int,
    version_name: str,
    changelog: str | None,
) -> None:
    sent = 0
    failed = 0
    inactive = 0
    with SessionLocal() as db:
        devices = db.scalars(
            select(UserDevice).outerjoin(UserNotificationPreference, UserNotificationPreference.user_id == UserDevice.user_id).where(
                UserDevice.is_active == True,  # noqa: E712
                UserDevice.platform == "android",
                (
                    UserDevice.fcm_token_ciphertext.is_not(None)
                    | UserDevice.fcm_token.is_not(None)
                ),
                ((UserNotificationPreference.id.is_(None)) | ((UserNotificationPreference.enabled == True) & (UserNotificationPreference.apk_updates == True))),  # noqa: E712
            )
        ).all()
        for device in devices:
            target = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
            if not target:
                device.is_active = False
                device.last_fcm_failure_code = "FCM_TOKEN_MISSING"
                inactive += 1
                failed += 1
                continue
            result = firebase_notification_service.send_update_notification(
                target,
                version_code=version_code,
                version_name=version_name,
                changelog=changelog,
                target_kind="fid" if device.push_provider == "fcm_fid" else "token",
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
