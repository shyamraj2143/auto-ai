import logging
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin

from sqlalchemy import select
from sqlalchemy.orm import Session
from jose import jwt

from app.core.config import settings
from app.models.call import Call, CallDelivery, UserCallSettings, UserDevice
from app.services.call_fallback_service import cancel_call_fallbacks, schedule_fallback
from app.models.user import User
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service

logger = logging.getLogger(__name__)


def _installation_hash(device_id: str) -> str:
    return hashlib.sha256(device_id.encode("utf-8")).hexdigest()[:16]


def create_call_action_token(call: Call, expires_at: datetime) -> str:
    return jwt.encode(
        {
            "sub": call.callee_id,
            "call_id": call.id,
            "scope": "call:action",
            "exp": expires_at,
            "jti": str(uuid.uuid4()),
        },
        settings.jwt_secret_key,
        algorithm=settings.JWT_ALGORITHM,
    )


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
        logger.info("call_fcm_skipped_unconfigured call_id=%s", call.id)
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
    action_token = create_call_action_token(call, expires_at)
    data = {
        "event_id": str(uuid.uuid4()),
        "action_token": action_token,
        "type": "incoming_call",
        "delivery_mode": "native_primary",
        "call_id": call.id,
        "call_revision": str(call.revision),
        "trace_id": call.trace_id,
        "caller_id": caller.id,
        "caller_name": caller.name[:120],
        "caller_username": (caller.username or f"user_{caller.id.replace('-', '')[:8]}")[:48],
        "caller_avatar_url": absolute_public_avatar(caller),
        "call_type": call.call_type,
        "created_at": now.isoformat(),
        "expires_at": expires_at.isoformat(),
        "expires_at_epoch_ms": str(int(expires_at.timestamp() * 1000)),
        "silent": str(silent).lower(),
        "notification_tag": f"autoai_call_{call.id}",
    }
    sent = 0
    logger.info("call_fcm_incoming_attempt call_id=%s devices=%d silent=%s", call.id, len(devices), silent)
    for device in devices:
        device_data = dict(data)
        device_data["event_id"] = str(uuid.uuid4())
        installation_hash = _installation_hash(device.device_id)
        logger.info("FCM_SEND_REQUESTED call_id=%s trace_id=%s event_id=%s installation_hash=%s app_version=%s result=REQUESTED timestamp=%s", call.id, call.trace_id, device_data["event_id"], installation_hash, device.app_version or "", now.isoformat())
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            device.last_fcm_send_result = "rejected"
            device.last_fcm_failure_code = "FCM_TOKEN_MISSING"
            logger.warning("call_fcm_incoming_inactive_token call_id=%s device_id=%s reason=missing_token", call.id, device.device_id)
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
            continue
        remaining_lifetime = max(20, min(40, int((expires_at - datetime.now(timezone.utc)).total_seconds())))
        result = firebase_notification_service.send_call_data(token, device_data, remaining_lifetime)
        if result.ok:
            sent += 1
            device.last_fcm_send_result = "accepted"
            device.last_fcm_failure_code = None
            logger.info("PRIMARY_FCM_ACCEPTED call_id=%s trace_id=%s event_id=%s installation_hash=%s app_version=%s", call.id, call.trace_id, device_data["event_id"], installation_hash, device.app_version or "")
            delivery = CallDelivery(
                call_id=call.id, device_id=device.id, primary_event_id=device_data["event_id"],
                primary_fcm_requested_at=datetime.utcnow(), primary_fcm_result="PRIMARY_ACCEPTED",
                fallback_due_at=datetime.utcnow() + timedelta(seconds=settings.CALL_SYSTEM_FALLBACK_DELAY_SECONDS), payload_json=json.dumps(device_data, separators=(",", ":")),
            )
            db.add(delivery)
            db.flush()
            if not schedule_fallback(delivery.id, delivery.fallback_due_at):
                delivery.last_delivery_failure_code = "FALLBACK_SCHEDULE_FAILED"
            logger.info("call_fcm_incoming_sent call_id=%s device_id=%s", call.id, device.device_id)
        elif result.inactive:
            device.last_fcm_send_result = "rejected"
            device.last_fcm_failure_code = result.failure_code or "FCM_TOKEN_UNREGISTERED"
            logger.warning("call_fcm_incoming_inactive_token call_id=%s device_id=%s detail=%s", call.id, device.device_id, result.detail[:160])
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
        else:
            device.last_fcm_send_result = "rejected"
            device.last_fcm_failure_code = result.failure_code or "FCM_REJECTED_BY_FIREBASE"
            logger.warning("FCM_SEND_FAILED call_id=%s trace_id=%s event_id=%s installation_hash=%s app_version=%s result=FCM_SEND_FAILED timestamp=%s", call.id, call.trace_id, data["event_id"], installation_hash, device.app_version or "", datetime.now(timezone.utc).isoformat())
            logger.warning("call_fcm_incoming_failed call_id=%s device_id=%s detail=%s", call.id, device.device_id, result.detail[:160])
    db.flush()
    return sent


def send_call_dismiss_notifications(db: Session, call: Call, event_type: str) -> int:
    cancel_call_fallbacks(call.id, db)
    if not firebase_notification_service.configured:
        logger.info("call_fcm_dismiss_skipped_unconfigured call_id=%s event_type=%s", call.id, event_type)
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
    logger.info("call_fcm_dismiss_attempt call_id=%s event_type=%s devices=%d", call.id, event_type, len(devices))
    for device in devices:
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            logger.warning("call_fcm_dismiss_inactive_token call_id=%s device_id=%s reason=missing_token", call.id, device.device_id)
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
            continue
        result = firebase_notification_service.send_call_data(
            token,
            {
                "event_id": str(uuid.uuid4()),
                "type": event_type,
                "notification_tag": f"autoai_call_{call.id}",
                "call_id": call.id,
                "call_revision": str(call.revision),
                "trace_id": call.trace_id,
                "call_type": call.call_type,
                "show_missed": str(event_type == "call_missed" and device.user_id == call.callee_id).lower(),
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            30,
        )
        if result.ok:
            sent += 1
            logger.info("call_fcm_dismiss_sent call_id=%s event_type=%s device_id=%s", call.id, event_type, device.device_id)
        elif result.inactive:
            logger.warning("call_fcm_dismiss_inactive_token call_id=%s event_type=%s device_id=%s detail=%s", call.id, event_type, device.device_id, result.detail[:160])
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.updated_at = datetime.utcnow()
        else:
            logger.warning("call_fcm_dismiss_failed call_id=%s event_type=%s device_id=%s detail=%s", call.id, event_type, device.device_id, result.detail[:160])
    db.flush()
    return sent
