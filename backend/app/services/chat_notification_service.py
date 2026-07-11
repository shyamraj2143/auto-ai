from datetime import datetime, timezone
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.call import UserDevice
from app.models.user import User
from app.models.user_chat import ChatMessage
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service


def _public_avatar(user: User) -> str:
    value = (user.avatar or user.picture or "")[:500]
    if not value or value.startswith(("https://", "http://")):
        return value
    return urljoin(settings.backend_url.rstrip("/") + "/", value.lstrip("/"))[:500]


def message_preview(message: ChatMessage) -> str:
    if message.message_type == "image":
        return "Sent an image"
    if message.message_type == "file":
        return f"Sent {message.attachment_name or 'a file'}"
    if message.message_type == "audio":
        return "Sent an audio message"
    return (message.text_content or "New message").strip()[:180]


def send_chat_message_notifications(db: Session, recipient_id: str, sender: User, message: ChatMessage) -> int:
    if not firebase_notification_service.configured:
        return 0
    devices = db.scalars(
        select(UserDevice).where(
            UserDevice.user_id == recipient_id,
            UserDevice.platform == "android",
            UserDevice.is_active == True,  # noqa: E712
            (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
        )
    ).all()
    preview = message_preview(message)
    data = {
        "type": "chat_message",
        "event_id": f"chat:{message.id}",
        "thread_id": message.thread_id,
        "message_id": message.id,
        "sender_id": sender.id,
        "sender_name": sender.name[:120],
        "sender_username": (sender.username or f"user_{sender.id.replace('-', '')[:8]}")[:48],
        "sender_avatar_url": _public_avatar(sender),
        "preview": preview,
        "created_at": datetime.now(timezone.utc).isoformat(),
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
        result = firebase_notification_service.send_chat_data(token, data, sender.name, preview)
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
