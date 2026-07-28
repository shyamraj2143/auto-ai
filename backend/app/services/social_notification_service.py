from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.call import UserDevice
from app.models.social import SocialNotification
from app.models.user import User
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service
from app.services.user_avatar import public_avatar
from app.services.notification_destination import with_notification_destination


def _avatar_url(user: User | None) -> str:
    if not user:
        return ""
    value = public_avatar(user)
    if not value or value.startswith(("https://", "http://")):
        return value
    return urljoin(settings.backend_url.rstrip("/") + "/", value.lstrip("/"))[:500]


def send_social_push_notification(db: Session, notification: SocialNotification, actor: User | None) -> int:
    if not firebase_notification_service.configured:
        return 0
    devices = db.scalars(
        select(UserDevice).where(
            UserDevice.user_id == notification.user_id,
            UserDevice.platform == "android",
            UserDevice.is_active == True,  # noqa: E712
            (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
        )
    ).all()
    data = with_notification_destination({
        "type": notification.notification_type,
        "event_id": notification.dedupe_key,
        "target_type": notification.target_type,
        "target_id": notification.target_id or "",
        "actor_id": actor.id if actor else "",
        "actor_name": actor.name[:120] if actor else "",
        "actor_username": (actor.username or f"user_{actor.id.replace('-', '')[:8]}")[:48] if actor else "",
        "actor_avatar_url": _avatar_url(actor),
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
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
        result = firebase_notification_service.send_chat_data(token, data, notification.title, notification.body or notification.title)
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
