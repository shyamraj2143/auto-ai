from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone

from redis import Redis
from redis.exceptions import RedisError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.call import Call, CallDelivery, UserDevice
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service
from app.services.notification_destination import with_notification_destination

logger = logging.getLogger(__name__)
QUEUE = "calls:fallback:due"


def _redis() -> Redis:
    if not settings.redis_url:
        raise RedisError("Redis is not configured")
    return Redis.from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=5, socket_timeout=5)


def schedule_fallback(delivery_id: str, due_at: datetime) -> bool:
    try:
        _redis().zadd(QUEUE, {delivery_id: due_at.timestamp()})
        logger.info("FALLBACK_SCHEDULED delivery_id=%s due_at=%s", delivery_id, due_at.isoformat())
        return True
    except (RedisError, OSError) as exc:
        logger.error("fallback_schedule_failed delivery_id=%s error=%s", delivery_id, type(exc).__name__)
        return False


def cancel_call_fallbacks(call_id: str, session: Session | None = None) -> None:
    if session is not None:
        ids = session.scalars(select(CallDelivery.id).where(CallDelivery.call_id == call_id, CallDelivery.fallback_sent_at.is_(None))).all()
    else:
        with SessionLocal() as db:
            ids = db.scalars(select(CallDelivery.id).where(CallDelivery.call_id == call_id, CallDelivery.fallback_sent_at.is_(None))).all()
    if not ids:
        return
    try:
        _redis().zrem(QUEUE, *ids)
    except (RedisError, OSError):
        logger.warning("fallback_cancel_redis_failed call_id=%s", call_id)


def acknowledge_delivery(
    call_id: str,
    installation_id: str,
    stage: str,
    event_id: str,
    original_priority: str | None = None,
    delivered_priority: str | None = None,
) -> bool:
    with SessionLocal() as db:
        delivery = db.scalar(select(CallDelivery).join(UserDevice, UserDevice.id == CallDelivery.device_id).where(
            CallDelivery.call_id == call_id, UserDevice.device_id == installation_id
        ))
        if not delivery or event_id not in {delivery.primary_event_id, delivery.fallback_event_id}:
            return False
        now = datetime.utcnow()
        if stage == "firebase_service_started":
            delivery.firebase_service_started_at = now
            delivery.original_priority = "HIGH" if original_priority == "1" else original_priority
            delivery.delivered_priority = "HIGH" if delivered_priority == "1" else delivered_priority
        elif stage == "device_received": delivery.native_received_at = now
        elif stage in {"notification_displayed", "callstyle_posted"}: delivery.notification_displayed_at = now
        elif stage == "ringtone_started": delivery.ringtone_started_at = now
        elif stage == "fallback_opened": delivery.fallback_opened_at = now
        else: return False
        db.commit()
        if stage in {"notification_displayed", "callstyle_posted"}:
            try: _redis().zrem(QUEUE, delivery.id)
            except (RedisError, OSError): logger.warning("fallback_ack_redis_failed delivery_id=%s", delivery.id)
        return True


def process_due_fallbacks(limit: int = 100) -> int:
    client = _redis()
    due = client.zrangebyscore(QUEUE, 0, time.time(), start=0, num=limit)
    sent = 0
    for delivery_id in due:
        lock_key = f"calls:fallback:lock:{delivery_id}"
        lock_value = str(uuid.uuid4())
        if not client.set(lock_key, lock_value, nx=True, ex=30):
            continue
        try:
            with SessionLocal() as db:
                delivery = db.get(CallDelivery, delivery_id)
                if not delivery:
                    client.zrem(QUEUE, delivery_id); continue
                call = db.get(Call, delivery.call_id)
                device = db.get(UserDevice, delivery.device_id)
                now = datetime.utcnow()
                if (not call or call.status not in {"initiated", "ringing"} or delivery.notification_displayed_at
                        or delivery.native_received_at or delivery.fallback_sent_at
                        or not delivery.fallback_due_at or now < delivery.fallback_due_at):
                    client.zrem(QUEUE, delivery_id); continue
                payload = json.loads(delivery.payload_json)
                expires_ms = int(payload["expires_at_epoch_ms"])
                ttl = (expires_ms - int(time.time() * 1000)) // 1000
                if ttl <= 0 or not device or not device.is_active:
                    delivery.fallback_fcm_result = "CALL_EXPIRED"
                    db.commit(); client.zrem(QUEUE, delivery_id); continue
                token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
                if not token:
                    delivery.fallback_fcm_result = "PRIMARY_UNREGISTERED"
                    db.commit(); client.zrem(QUEUE, delivery_id); continue
                fallback_event_id = str(uuid.uuid4())
                payload.update({"type": "incoming_call_fallback", "delivery_mode": "system_fallback", "event_id": fallback_event_id})
                payload = with_notification_destination(payload)
                result = firebase_notification_service.send_call_system_fallback(
                    token, payload, payload.get("caller_name") or "Incoming AutoAI call",
                    f"Incoming AutoAI {payload.get('call_type', 'audio')} call — tap to answer", ttl, f"autoai_call_{call.id}",
                    target_kind="fid" if device.push_provider == "fcm_fid" else "token",
                )
                delivery.fallback_event_id = fallback_event_id
                delivery.fallback_sent_at = now
                delivery.fallback_fcm_result = "FALLBACK_ACCEPTED" if result.ok else "FALLBACK_REJECTED"
                delivery.last_delivery_failure_code = None if result.ok else result.failure_code
                db.commit()
                client.zrem(QUEUE, delivery_id)
                logger.info("FALLBACK_FCM_ACCEPTED call_id=%s delivery_id=%s", call.id, delivery.id) if result.ok else logger.warning("fallback_fcm_rejected call_id=%s code=%s", call.id, result.failure_code)
                sent += int(result.ok)
        finally:
            if client.get(lock_key) == lock_value: client.delete(lock_key)
    return sent
