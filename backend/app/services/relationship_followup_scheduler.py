from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.call import UserDevice
from app.models.relationship_followup import (
    RelationshipContact,
    RelationshipDeliveryAttempt,
    RelationshipFollowupEvent,
    RelationshipNotificationPreference,
)
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service
from app.services.notification_destination import with_notification_destination


logger = logging.getLogger("auto_ai.relationship_followups")
PROCESSING_TIMEOUT = timedelta(minutes=10)
MAX_ATTEMPTS = 5
BACKOFF_MINUTES = (1, 5, 30, 120, 360)


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def recover_stale_claims(db: Session, now: datetime | None = None) -> int:
    current = now or utc_now()
    result = db.execute(
        update(RelationshipFollowupEvent)
        .where(
            RelationshipFollowupEvent.status == "processing",
            RelationshipFollowupEvent.claimed_at < current - PROCESSING_TIMEOUT,
        )
        .values(status="pending", claim_token=None, claimed_at=None, failure_code="STALE_CLAIM_RECOVERED")
    )
    db.commit()
    return int(result.rowcount or 0)


def claim_due_events(db: Session, limit: int, now: datetime | None = None) -> list[tuple[str, str]]:
    current = now or utc_now()
    recover_stale_claims(db, current)
    candidate_ids = list(db.scalars(
        select(RelationshipFollowupEvent.id)
        .join(RelationshipContact, RelationshipContact.id == RelationshipFollowupEvent.relationship_contact_id)
        .join(RelationshipNotificationPreference, RelationshipNotificationPreference.user_id == RelationshipFollowupEvent.user_id)
        .where(
            RelationshipFollowupEvent.status.in_(("pending", "snoozed")),
            RelationshipFollowupEvent.scheduled_at <= current,
            (RelationshipFollowupEvent.next_attempt_at.is_(None) | (RelationshipFollowupEvent.next_attempt_at <= current)),
            RelationshipContact.status == "active",
            RelationshipNotificationPreference.enabled == True,  # noqa: E712
        )
        .order_by(RelationshipFollowupEvent.scheduled_at.asc())
        .limit(max(1, min(limit, 100)))
    ).all())
    claimed: list[tuple[str, str]] = []
    for event_id in candidate_ids:
        token = str(uuid.uuid4())
        result = db.execute(
            update(RelationshipFollowupEvent)
            .where(
                RelationshipFollowupEvent.id == event_id,
                RelationshipFollowupEvent.status.in_(("pending", "snoozed")),
            )
            .values(
                status="processing",
                claim_token=token,
                claimed_at=current,
                attempt_count=RelationshipFollowupEvent.attempt_count + 1,
                failure_code=None,
            )
        )
        if result.rowcount == 1:
            claimed.append((event_id, token))
        db.commit()
    return claimed


def _retry_or_fail(event: RelationshipFollowupEvent, failure_code: str, now: datetime) -> None:
    event.claim_token = None
    event.claimed_at = None
    event.failure_code = failure_code[:64]
    if event.attempt_count >= MAX_ATTEMPTS:
        event.status = "failed"
        event.next_attempt_at = None
        return
    event.status = "pending"
    event.next_attempt_at = now + timedelta(minutes=BACKOFF_MINUTES[min(event.attempt_count - 1, len(BACKOFF_MINUTES) - 1)])


def deliver_claimed_event(db: Session, event_id: str, claim_token: str, now: datetime | None = None) -> bool:
    current = now or utc_now()
    event = db.scalar(select(RelationshipFollowupEvent).where(
        RelationshipFollowupEvent.id == event_id,
        RelationshipFollowupEvent.status == "processing",
        RelationshipFollowupEvent.claim_token == claim_token,
    ).with_for_update())
    if not event:
        return False
    contact = db.scalar(select(RelationshipContact).where(
        RelationshipContact.id == event.relationship_contact_id,
        RelationshipContact.user_id == event.user_id,
    ))
    preference = db.scalar(select(RelationshipNotificationPreference).where(
        RelationshipNotificationPreference.user_id == event.user_id,
    ))
    if not contact or contact.status != "active":
        event.status = "cancelled"
        event.claim_token = None
        event.claimed_at = None
        event.failure_code = "CONTACT_INACTIVE"
        db.commit()
        return False
    if not preference or not preference.enabled:
        event.status = "pending"
        event.claim_token = None
        event.claimed_at = None
        event.failure_code = "PREFERENCE_DISABLED"
        db.commit()
        return False

    notification_event_id = f"relationship:{event.id}"
    title = "संपर्क बनाए रखने का समय" if contact.preferred_language == "hi" else "Time to stay in touch"
    if preference.detailed_preview:
        body = (
            f"आज {contact.display_name} से बात करने का आपका reminder है।"
            if contact.preferred_language == "hi"
            else f"Your reminder to contact {contact.display_name} is due."
        )
    else:
        body = (
            "आपका एक relationship follow-up reminder है।"
            if contact.preferred_language == "hi"
            else "You have a relationship follow-up reminder."
        )
    data = with_notification_destination({
        "type": "relationship_followup",
        "event_id": notification_event_id,
        "contact_id": contact.id,
        "scheduled_at": event.scheduled_at.replace(tzinfo=timezone.utc).isoformat(),
        "preview": "detailed" if preference.detailed_preview else "private",
    })
    devices = db.scalars(select(UserDevice).where(
        UserDevice.user_id == event.user_id,
        UserDevice.platform == "android",
        UserDevice.is_active == True,  # noqa: E712
        (UserDevice.fcm_token_ciphertext.is_not(None) | UserDevice.fcm_token.is_not(None)),
    )).all()
    sent = 0
    last_failure = "NO_ACTIVE_DEVICE"
    for device in devices:
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            last_failure = "FCM_TOKEN_MISSING"
            db.add(RelationshipDeliveryAttempt(
                event_id=event.id,
                user_id=event.user_id,
                device_id=device.id,
                attempt_number=event.attempt_count,
                status="failed",
                failure_code=last_failure,
            ))
            continue
        result = firebase_notification_service.send_relationship_followup(
            token,
            data,
            title,
            body,
            target_kind="fid" if device.push_provider == "fcm_fid" else "token",
        )
        attempt_status = "sent" if result.ok else "failed"
        last_failure = result.failure_code or ("FCM_SEND_FAILED" if not result.ok else "")
        db.add(RelationshipDeliveryAttempt(
            event_id=event.id,
            user_id=event.user_id,
            device_id=device.id,
            attempt_number=event.attempt_count,
            status=attempt_status,
            failure_code=last_failure or None,
        ))
        if result.ok:
            sent += 1
        elif result.inactive:
            device.is_active = False
            device.fcm_token = None
            device.fcm_token_ciphertext = None
            device.fcm_token_hash = None
            device.last_fcm_failure_code = result.failure_code
            device.updated_at = current
    if sent:
        event.status = "sent"
        event.sent_at = current
        event.notification_event_id = notification_event_id
        event.claim_token = None
        event.claimed_at = None
        event.failure_code = None
        event.next_attempt_at = None
    else:
        _retry_or_fail(event, last_failure, current)
    db.commit()
    return sent > 0


def process_due_followups(limit: int | None = None) -> tuple[int, int]:
    batch_size = limit or settings.RELATIONSHIP_FOLLOWUP_BATCH_SIZE
    with SessionLocal() as db:
        claims = claim_due_events(db, batch_size)
    sent = 0
    failed = 0
    for event_id, token in claims:
        try:
            with SessionLocal() as db:
                sent += int(deliver_claimed_event(db, event_id, token))
        except Exception as exc:  # one delivery must never stop the worker
            failed += 1
            logger.exception("relationship_followup_delivery_failed event_id=%s error_type=%s", event_id, type(exc).__name__)
            with SessionLocal() as db:
                event = db.scalar(select(RelationshipFollowupEvent).where(
                    RelationshipFollowupEvent.id == event_id,
                    RelationshipFollowupEvent.claim_token == token,
                ))
                if event:
                    _retry_or_fail(event, "UNEXPECTED_DELIVERY_ERROR", utc_now())
                    db.commit()
    return sent, failed


async def relationship_followup_worker(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            await asyncio.to_thread(process_due_followups)
        except Exception as exc:
            logger.exception("relationship_followup_worker_cycle_failed error_type=%s", type(exc).__name__)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=settings.RELATIONSHIP_FOLLOWUP_POLL_SECONDS)
        except asyncio.TimeoutError:
            continue
