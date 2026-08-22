from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.call import UserDevice
from app.models.push import UserNotificationPreference
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service
from app.services.notification_destination import with_notification_destination

logger = logging.getLogger(__name__)


def send_seva_push(db: Session, recipient_id: str, work_order_id: str, event_id: str, title: str, body: str, deep_link: str) -> int:
    if not firebase_notification_service.configured:
        return 0
    preference = db.scalar(select(UserNotificationPreference).where(UserNotificationPreference.user_id == recipient_id))
    if preference and (not preference.enabled or not preference.seva_updates):
        return 0
    devices = list(db.scalars(select(UserDevice).where(
        UserDevice.user_id == recipient_id,
        UserDevice.platform == "android",
        UserDevice.is_active.is_(True),
        (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
    )))
    application_id = deep_link.rsplit("/", 1)[-1] if deep_link.startswith("/seva/applications/") else work_order_id
    data = with_notification_destination({
        "type": "seva_case_update",
        "event_id": event_id,
        "work_order_id": work_order_id,
        "application_id": application_id,
        "case_route_id": application_id,
        "secondary_id": "agent" if deep_link.startswith("/agent/") else "user",
        "deep_link": deep_link,
        "title": title,
        "body": body,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    sent = 0
    for device in devices:
        try:
            token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
            if not token:
                continue
            # Send data-only so the Android FirebaseMessagingService receives the
            # event in background/terminated state and can build the Seva-specific
            # notification + deep link itself.
            result = firebase_notification_service.send_seva_data(
                token,
                data,
                target_kind="fid" if device.push_provider == "fcm_fid" else "token",
            )
            sent += int(result.ok)
            if result.inactive:
                device.is_active = False
                device.updated_at = datetime.utcnow()
        except Exception:
            logger.exception("Seva push delivery failed for device %s", device.id)
    db.commit()
    return sent
