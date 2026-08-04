from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.alarm import UserAlarm
from app.models.call import UserDevice
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service


logger = logging.getLogger(__name__)


def alarm_sync_data(alarm: UserAlarm, action: str) -> dict[str, str]:
    scheduled = alarm.scheduled_at.replace(tzinfo=UTC) if alarm.scheduled_at.tzinfo is None else alarm.scheduled_at.astimezone(UTC)
    return {
        "type": "alarm_sync",
        "action": action,
        "alarm_id": alarm.id,
        "title": alarm.title[:120],
        "note": alarm.note[:500],
        "scheduled_at_epoch_ms": str(int(scheduled.timestamp() * 1000)),
        "timezone": alarm.timezone[:80],
        "language": alarm.language,
        "voice_style": alarm.voice_style,
        "ringtone": alarm.ringtone,
        "local_time": alarm.local_time,
        "alarm_date": alarm.alarm_date or "",
        "recurrence_type": alarm.recurrence_type,
        "start_date": alarm.start_date or "",
        "end_date": alarm.end_date or "",
        "repeat": alarm.repeat_rule,
        "snooze_minutes": str(alarm.snooze_minutes),
        "snooze_enabled": str(bool(alarm.snooze_enabled)).lower(),
        "max_snooze_count": str(alarm.max_snooze_count),
        "gradual_volume_enabled": str(bool(alarm.gradual_volume_enabled)).lower(),
        "vibration": str(bool(alarm.vibration)).lower(),
        "assistant_message": alarm.assistant_message[:480],
        "enabled": str(bool(alarm.enabled)).lower(),
        "status": alarm.status,
        "revision": str(alarm.revision),
    }


def deleted_alarm_sync_data(alarm_id: str, revision: int) -> dict[str, str]:
    return {
        "type": "alarm_sync",
        "action": "delete",
        "alarm_id": alarm_id,
        "revision": str(revision),
    }


def dispatch_alarm_sync(user_id: str, data: dict[str, str]) -> None:
    if not firebase_notification_service.configured:
        logger.info("alarm_sync_skipped reason=firebase_unconfigured alarm_id=%s", data.get("alarm_id"))
        return
    with SessionLocal() as db:
        sent = _send_to_user_devices(db, user_id, data)
        db.commit()
    logger.info("alarm_sync_complete alarm_id=%s action=%s sent=%d", data.get("alarm_id"), data.get("action"), sent)


def _send_to_user_devices(db: Session, user_id: str, data: dict[str, str]) -> int:
    devices = db.scalars(
        select(UserDevice).where(
            UserDevice.user_id == user_id,
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
            continue
        result = firebase_notification_service.send_alarm_data(
            token,
            data,
            target_kind="fid" if device.push_provider == "fcm_fid" else "token",
        )
        if result.ok:
            sent += 1
            device.last_fcm_send_result = "accepted"
            device.last_fcm_failure_code = None
        elif result.inactive:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.last_fcm_send_result = "rejected"
            device.last_fcm_failure_code = result.failure_code
        else:
            device.last_fcm_send_result = "rejected"
            device.last_fcm_failure_code = result.failure_code
        device.updated_at = datetime.utcnow()
    db.flush()
    return sent
