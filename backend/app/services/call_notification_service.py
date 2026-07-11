from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.call import Call, UserCallSettings, UserDevice
from app.models.user import User
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service


def public_avatar(user: User) -> str:
    return (user.avatar or user.picture or "")[:500]


def absolute_public_avatar(user: User) -> str:
    value = public_avatar(user)
    if not value or value.startswith(("https://", "http://")):
        return value
    return urljoin(settings.backend_url.rstrip("/") + "/", value.lstrip("/"))[:500]


def send_incoming_call_notifications(
    db: Session,
    call: Call,
    caller: User,
    call_settings: UserCallSettings,
    *,
    silent: bool,
) -> int:
    if not firebase_notification_service.configured:
        return 0
    devices = db.scalars(
        select(UserDevice).where(
            UserDevice.user_id == call.callee_id,
            UserDevice.platform == "android",
            UserDevice.is_active == True,  # noqa: E712
            (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
        )
    ).all()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=settings.CALL_RING_TIMEOUT_SECONDS)
    data = {
        "type": "incoming_call",
        "call_id": call.id,
        "caller_id": caller.id,
        "caller_name": caller.name[:120],
        "caller_username": (caller.username or f"user_{caller.id.replace('-', '')[:8]}")[:48],
        "caller_avatar_url": absolute_public_avatar(caller),
        "call_type": call.call_type,
        "created_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
        "expires_at_epoch_ms": str(int(expires_at.timestamp() * 1000)),
        "silent": str(silent).lower(),
    }
    sent = 0
    for device in devices:
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
            continue
        result = firebase_notification_service.send_call_data(token, data, settings.CALL_NOTIFICATION_TTL_SECONDS)
        if result.ok:
            sent += 1
        elif result.inactive:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
    db.flush()
    return sent


def send_call_dismiss_notifications(db: Session, call: Call, event_type: str) -> int:
    if not firebase_notification_service.configured:
        return 0
    devices = db.scalars(
        select(UserDevice).where(
            UserDevice.user_id.in_([call.caller_id, call.callee_id]),
            UserDevice.platform == "android",
            UserDevice.is_active == True,  # noqa: E712
            (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
        )
    ).all()
    sent = 0
    for device in devices:
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
            continue
        result = firebase_notification_service.send_call_data(
            token,
            {
                "type": event_type,
                "call_id": call.id,
                "call_type": call.call_type,
                "show_missed": str(event_type == "call_missed" and device.user_id == call.callee_id).lower(),
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            30,
        )
        if result.ok:
            sent += 1
        elif result.inactive:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
    db.flush()
    return sent
