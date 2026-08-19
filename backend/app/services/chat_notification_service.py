from datetime import datetime, timezone
from threading import Thread
from urllib.parse import urljoin

from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import event, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.call import UserDevice
from app.models.chat_generation import ChatGeneration
from app.models.user import User
from app.models.user_chat import ChatMessage
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service
from app.services.user_avatar import public_avatar
from app.services.notification_destination import with_notification_destination


_presence_redis: Redis | None = None
PRESENCE_KEY_PREFIX = "autoai:app_presence:"


def _public_avatar(user: User) -> str:
    value = public_avatar(user)
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
    data = with_notification_destination({
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
        result = firebase_notification_service.send_chat_data(
            token,
            data,
            sender.name,
            preview,
            target_kind="fid" if device.push_provider == "fcm_fid" else "token",
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


def _is_app_foreground(user_id: str) -> bool:
    """Best-effort cross-worker foreground check. Missing Redis state means notify."""
    if not settings.redis_url:
        return False
    global _presence_redis
    try:
        if _presence_redis is None:
            _presence_redis = Redis.from_url(
                settings.redis_url,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=2,
                health_check_interval=30,
            )
        state = _presence_redis.get(f"{PRESENCE_KEY_PREFIX}{user_id}")
        return state == "foreground"
    except (RedisError, OSError, TypeError, ValueError):
        return False


def _send_ai_response_ready(generation_id: str) -> None:
    """Send a durable FCM notification only when the user is not in the app."""
    try:
        with SessionLocal() as db:
            generation = db.get(ChatGeneration, generation_id)
            if not generation or generation.status != "completed":
                return
            payload = dict(generation.request_payload or {})
            if payload.get("ai_response_notification_sent"):
                return
            user = db.get(User, generation.user_id)
            if not user or not firebase_notification_service.configured:
                return

            # The frontend sends a short-lived foreground heartbeat. Do not
            # interrupt an active app session with a redundant system alert.
            if _is_app_foreground(user.id):
                payload["ai_response_notification_suppressed"] = True
                generation.request_payload = payload
                db.add(generation)
                db.commit()
                return

            devices = db.scalars(
                select(UserDevice).where(
                    UserDevice.user_id == user.id,
                    UserDevice.platform == "android",
                    UserDevice.is_active == True,  # noqa: E712
                    (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
                )
            ).all()
            data = with_notification_destination({
                "type": "chat_message",
                "event_id": f"ai_response:{generation.id}",
                "thread_id": generation.chat_id,
                "message_id": generation.assistant_message_id or generation.id,
                "sender_id": user.id,
                "sender_name": "Auto-AI",
                "sender_username": "auto-ai",
                "sender_avatar_url": "",
                "preview": "Your response is ready.",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "ai_response_ready": "true",
            })
            sent = 0
            for device in devices:
                token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
                if not token:
                    device.is_active = False
                    continue
                result = firebase_notification_service.send_chat_data(
                    token,
                    data,
                    "Auto-AI",
                    "Your response is ready.",
                    target_kind="fid" if device.push_provider == "fcm_fid" else "token",
                )
                if result.ok:
                    sent += 1
                elif result.inactive:
                    device.is_active = False
                    device.fcm_token = None
                    device.fcm_token_ciphertext = None
                    device.fcm_token_hash = None
            payload["ai_response_notification_sent"] = sent > 0
            generation.request_payload = payload
            db.add(generation)
            db.commit()
    except Exception:
        # Notification failure must never fail or roll back the completed AI response.
        return


@event.listens_for(Session, "after_flush")
def _queue_ai_completion_notifications(session: Session, flush_context) -> None:
    del flush_context
    queued = session.info.setdefault("auto_ai_completed_generations", set())
    for obj in session.dirty:
        if isinstance(obj, ChatGeneration) and obj.status == "completed":
            payload = dict(obj.request_payload or {})
            if not payload.get("ai_response_notification_sent") and not payload.get("ai_response_notification_suppressed"):
                queued.add(obj.id)


@event.listens_for(Session, "after_commit")
def _deliver_ai_completion_notifications(session: Session) -> None:
    queued = set(session.info.pop("auto_ai_completed_generations", set()))
    for generation_id in queued:
        Thread(target=_send_ai_response_ready, args=(generation_id,), daemon=True).start()
