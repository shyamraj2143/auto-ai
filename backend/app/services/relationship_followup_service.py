from __future__ import annotations

import calendar
import json
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.relationship_followup import (
    RelationshipAuditEvent,
    RelationshipContact,
    RelationshipFollowupEvent,
    RelationshipInteraction,
    RelationshipNotificationPreference,
)
from app.schemas.relationship_followup import ContactCreate, ContactUpdate
from app.services.sensitive_data import decrypt_sensitive_text, encrypt_sensitive_text


CADENCE_DAYS = {"weekly": 7, "fortnightly": 15, "monthly": 30, "quarterly": 90}
ACTIVE_EVENT_STATUSES = {"pending", "snoozed", "processing"}


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Date and time must include a timezone offset.")
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def utc_aware(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


def cadence_days(cadence: str, custom_days: int | None) -> int:
    if cadence == "custom":
        if custom_days is None or not 1 <= custom_days <= 730:
            raise HTTPException(status_code=422, detail="Custom cadence must be between 1 and 730 days.")
        return custom_days
    return CADENCE_DAYS[cadence]


def _add_months(value: datetime, months: int) -> datetime:
    target_month = value.month - 1 + months
    year = value.year + target_month // 12
    month = target_month % 12 + 1
    day = min(value.day, calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def next_followup_time(contact: RelationshipContact, contacted_at_utc: datetime) -> datetime:
    zone = ZoneInfo(contact.timezone)
    local_contacted = contacted_at_utc.replace(tzinfo=timezone.utc).astimezone(zone)
    if contact.cadence == "monthly":
        target = _add_months(local_contacted, 1)
    elif contact.cadence == "quarterly":
        target = _add_months(local_contacted, 3)
    else:
        target = local_contacted + timedelta(days=contact.followup_interval_days)
    hour, minute = (int(part) for part in contact.preferred_reminder_time.split(":"))
    local_target = datetime.combine(target.date(), time(hour, minute), tzinfo=zone)
    return local_target.astimezone(timezone.utc).replace(tzinfo=None)


def event_dedupe_key(contact_id: str, scheduled_at: datetime) -> str:
    return f"relationship:{contact_id}:{scheduled_at.replace(microsecond=0).isoformat()}Z"


def due_bucket_for(contact: RelationshipContact, now: datetime) -> str:
    if contact.status != "active":
        return contact.status
    if contact.next_followup_at < now:
        return "overdue"
    zone = ZoneInfo(contact.timezone)
    local_now = now.replace(tzinfo=timezone.utc).astimezone(zone)
    local_due = contact.next_followup_at.replace(tzinfo=timezone.utc).astimezone(zone)
    return "today" if local_due.date() == local_now.date() else "upcoming"


def contact_json(contact: RelationshipContact) -> dict[str, object]:
    return {
        "id": contact.id,
        "display_name": contact.display_name,
        "relationship_type": contact.relationship_type,
        "preferred_channel": contact.preferred_channel,
        "contact_value": decrypt_sensitive_text(contact.contact_value_ciphertext),
        "last_contacted_at": utc_aware(contact.last_contacted_at),
        "cadence": contact.cadence,
        "followup_interval_days": contact.followup_interval_days,
        "next_followup_at": utc_aware(contact.next_followup_at),
        "preferred_reminder_time": contact.preferred_reminder_time,
        "timezone": contact.timezone,
        "priority": contact.priority,
        "notes": decrypt_sensitive_text(contact.notes_ciphertext),
        "preferred_language": contact.preferred_language,
        "status": contact.status,
        "revision": contact.revision,
        "created_at": utc_aware(contact.created_at),
        "updated_at": utc_aware(contact.updated_at),
    }


def interaction_json(item: RelationshipInteraction) -> dict[str, object]:
    return {
        "id": item.id,
        "contacted_at": utc_aware(item.contacted_at),
        "channel": item.channel,
        "note": decrypt_sensitive_text(item.note_ciphertext),
        "created_at": utc_aware(item.created_at),
    }


def event_json(item: RelationshipFollowupEvent) -> dict[str, object]:
    return {
        "id": item.id,
        "scheduled_at": utc_aware(item.scheduled_at),
        "status": item.status,
        "completed_at": utc_aware(item.completed_at),
        "snoozed_until": utc_aware(item.snoozed_until),
        "sent_at": utc_aware(item.sent_at),
        "attempt_count": item.attempt_count,
        "failure_code": item.failure_code,
    }


class RelationshipFollowupService:
    def owned(self, db: Session, user_id: str, contact_id: str, *, lock: bool = False) -> RelationshipContact:
        statement = select(RelationshipContact).where(
            RelationshipContact.id == contact_id,
            RelationshipContact.user_id == user_id,
        )
        if lock:
            statement = statement.with_for_update()
        contact = db.scalar(statement)
        if not contact:
            raise HTTPException(status_code=404, detail="Relationship follow-up not found.")
        return contact

    @staticmethod
    def assert_revision(contact: RelationshipContact, revision: int) -> None:
        if contact.revision != revision:
            raise HTTPException(status_code=409, detail="This follow-up changed on another device. Refresh and try again.")

    @staticmethod
    def audit(db: Session, user_id: str, contact_id: str | None, event_type: str, request_id: str, metadata: dict[str, object] | None = None) -> RelationshipAuditEvent:
        existing = db.scalar(select(RelationshipAuditEvent).where(
            RelationshipAuditEvent.user_id == user_id,
            RelationshipAuditEvent.request_id == request_id,
            RelationshipAuditEvent.event_type == event_type,
        ))
        if existing:
            return existing
        item = RelationshipAuditEvent(
            user_id=user_id,
            relationship_contact_id=contact_id,
            event_type=event_type,
            request_id=request_id,
            metadata_json=json.dumps(metadata or {}, separators=(",", ":"), sort_keys=True),
        )
        db.add(item)
        return item

    @staticmethod
    def schedule_event(db: Session, contact: RelationshipContact) -> RelationshipFollowupEvent:
        key = event_dedupe_key(contact.id, contact.next_followup_at)
        existing = db.scalar(select(RelationshipFollowupEvent).where(
            RelationshipFollowupEvent.user_id == contact.user_id,
            RelationshipFollowupEvent.deduplication_key == key,
        ))
        if existing:
            return existing
        event = RelationshipFollowupEvent(
            user_id=contact.user_id,
            relationship_contact_id=contact.id,
            scheduled_at=contact.next_followup_at,
            status="pending",
            deduplication_key=key,
        )
        db.add(event)
        return event

    @staticmethod
    def cancel_active_events(db: Session, contact: RelationshipContact, *, completed: bool = False) -> None:
        now = utc_now()
        for event in db.scalars(select(RelationshipFollowupEvent).where(
            RelationshipFollowupEvent.user_id == contact.user_id,
            RelationshipFollowupEvent.relationship_contact_id == contact.id,
            RelationshipFollowupEvent.status.in_(ACTIVE_EVENT_STATUSES),
        )).all():
            event.status = "completed" if completed else "cancelled"
            event.completed_at = now if completed else None
            event.claim_token = None
            event.claimed_at = None

    def create(self, db: Session, user_id: str, payload: ContactCreate) -> RelationshipContact:
        existing = db.scalar(select(RelationshipContact).where(
            RelationshipContact.user_id == user_id,
            RelationshipContact.client_request_id == payload.client_request_id,
        ))
        if existing:
            return existing
        next_due = utc_naive(payload.next_followup_at)
        if next_due <= utc_now():
            raise HTTPException(status_code=422, detail="The first follow-up must be scheduled in the future.")
        contact = RelationshipContact(
            user_id=user_id,
            display_name=payload.display_name,
            relationship_type=payload.relationship_type,
            preferred_channel=payload.preferred_channel,
            contact_value_ciphertext=encrypt_sensitive_text(payload.contact_value),
            last_contacted_at=utc_naive(payload.last_contacted_at) if payload.last_contacted_at else None,
            cadence=payload.cadence,
            followup_interval_days=cadence_days(payload.cadence, payload.followup_interval_days),
            next_followup_at=next_due,
            preferred_reminder_time=payload.preferred_reminder_time,
            timezone=payload.timezone,
            priority=payload.priority,
            notes_ciphertext=encrypt_sensitive_text(payload.notes),
            preferred_language=payload.preferred_language,
            status="active",
            client_request_id=payload.client_request_id,
        )
        db.add(contact)
        db.flush()
        self.schedule_event(db, contact)
        self.audit(db, user_id, contact.id, "contact.created", payload.client_request_id, {"priority": contact.priority})
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            duplicate = db.scalar(select(RelationshipContact).where(
                RelationshipContact.user_id == user_id,
                RelationshipContact.client_request_id == payload.client_request_id,
            ))
            if duplicate:
                return duplicate
            raise
        db.refresh(contact)
        return contact

    def update(self, db: Session, user_id: str, contact_id: str, payload: ContactUpdate) -> RelationshipContact:
        contact = self.owned(db, user_id, contact_id, lock=True)
        duplicate = db.scalar(select(RelationshipAuditEvent).where(
            RelationshipAuditEvent.user_id == user_id,
            RelationshipAuditEvent.request_id == payload.request_id,
            RelationshipAuditEvent.event_type == "contact.updated",
        ))
        if duplicate:
            return contact
        self.assert_revision(contact, payload.revision)
        changes = payload.model_dump(exclude_unset=True, exclude={"revision", "request_id"})
        if "next_followup_at" in changes and changes["next_followup_at"] is not None:
            changes["next_followup_at"] = utc_naive(changes["next_followup_at"])
            if changes["next_followup_at"] <= utc_now():
                raise HTTPException(status_code=422, detail="Follow-up time must be in the future.")
        if "last_contacted_at" in changes and changes["last_contacted_at"] is not None:
            changes["last_contacted_at"] = utc_naive(changes["last_contacted_at"])
        if "contact_value" in changes:
            contact.contact_value_ciphertext = encrypt_sensitive_text(changes.pop("contact_value"))
        if "notes" in changes:
            contact.notes_ciphertext = encrypt_sensitive_text(changes.pop("notes"))
        for name, value in changes.items():
            setattr(contact, name, value)
        contact.followup_interval_days = cadence_days(contact.cadence, contact.followup_interval_days)
        contact.revision += 1
        contact.updated_at = utc_now()
        self.cancel_active_events(db, contact)
        if contact.status == "active":
            self.schedule_event(db, contact)
        self.audit(db, user_id, contact.id, "contact.updated", payload.request_id)
        db.commit()
        db.refresh(contact)
        return contact

    def list_contacts(
        self,
        db: Session,
        user_id: str,
        *,
        query: str,
        relationship_type: str | None,
        priority: str | None,
        bucket: str | None,
        sort: str,
        page: int,
        limit: int,
    ) -> tuple[list[RelationshipContact], int]:
        now = utc_now()
        filters = [RelationshipContact.user_id == user_id]
        if query:
            filters.append(func.lower(RelationshipContact.display_name).contains(query.lower()))
        if relationship_type:
            filters.append(RelationshipContact.relationship_type == relationship_type)
        if priority:
            filters.append(RelationshipContact.priority == priority)
        if bucket == "overdue":
            filters.extend([RelationshipContact.status == "active", RelationshipContact.next_followup_at < now])
        elif bucket == "today":
            filters.append(RelationshipContact.status == "active")
        elif bucket == "upcoming":
            filters.append(RelationshipContact.status == "active")
        elif bucket in {"paused", "archived"}:
            filters.append(RelationshipContact.status == bucket)
        elif bucket == "recent":
            filters.append(RelationshipContact.last_contacted_at >= now - timedelta(days=30))
        else:
            filters.append(RelationshipContact.status != "archived")
        statement = select(RelationshipContact).where(and_(*filters))
        statement = statement.order_by(
            RelationshipContact.next_followup_at.desc() if sort == "due_desc" else RelationshipContact.next_followup_at.asc(),
            RelationshipContact.display_name.asc(),
        )
        if bucket in {"today", "upcoming"}:
            candidates = list(db.scalars(statement).all())
            filtered = [item for item in candidates if due_bucket_for(item, now) == bucket]
            total = len(filtered)
            items = filtered[(page - 1) * limit:page * limit]
        else:
            total = int(db.scalar(select(func.count()).select_from(RelationshipContact).where(and_(*filters))) or 0)
            items = list(db.scalars(statement.offset((page - 1) * limit).limit(limit)).all())
        return items, total

    def detail(self, db: Session, user_id: str, contact_id: str) -> dict[str, object]:
        contact = self.owned(db, user_id, contact_id)
        interactions = db.scalars(select(RelationshipInteraction).where(
            RelationshipInteraction.user_id == user_id,
            RelationshipInteraction.relationship_contact_id == contact.id,
        ).order_by(RelationshipInteraction.contacted_at.desc()).limit(100)).all()
        events = db.scalars(select(RelationshipFollowupEvent).where(
            RelationshipFollowupEvent.user_id == user_id,
            RelationshipFollowupEvent.relationship_contact_id == contact.id,
        ).order_by(RelationshipFollowupEvent.created_at.desc()).limit(100)).all()
        return {**contact_json(contact), "interactions": [interaction_json(x) for x in interactions], "events": [event_json(x) for x in events]}

    def set_status(self, db: Session, user_id: str, contact_id: str, revision: int, request_id: str, new_status: str) -> RelationshipContact:
        event_type = f"contact.{new_status}"
        contact = self.owned(db, user_id, contact_id, lock=True)
        duplicate = db.scalar(select(RelationshipAuditEvent).where(
            RelationshipAuditEvent.user_id == user_id,
            RelationshipAuditEvent.request_id == request_id,
            RelationshipAuditEvent.event_type == event_type,
        ))
        if duplicate:
            return contact
        self.assert_revision(contact, revision)
        contact.status = new_status
        contact.revision += 1
        contact.updated_at = utc_now()
        self.cancel_active_events(db, contact)
        if new_status == "active":
            if contact.next_followup_at <= utc_now():
                contact.next_followup_at = next_followup_time(contact, utc_now())
            self.schedule_event(db, contact)
        self.audit(db, user_id, contact.id, event_type, request_id)
        db.commit()
        db.refresh(contact)
        return contact

    def mark_contacted(self, db: Session, user_id: str, contact_id: str, revision: int, request_id: str, contacted_at: datetime, channel: str | None, note: str) -> RelationshipContact:
        contact = self.owned(db, user_id, contact_id, lock=True)
        duplicate = db.scalar(select(RelationshipInteraction).where(
            RelationshipInteraction.user_id == user_id,
            RelationshipInteraction.request_id == request_id,
        ))
        if duplicate:
            return contact
        self.assert_revision(contact, revision)
        contacted = utc_naive(contacted_at)
        if contacted > utc_now() + timedelta(minutes=5):
            raise HTTPException(status_code=422, detail="Contacted time cannot be in the future.")
        db.add(RelationshipInteraction(
            user_id=user_id,
            relationship_contact_id=contact.id,
            contacted_at=contacted,
            channel=channel or contact.preferred_channel,
            note_ciphertext=encrypt_sensitive_text(note),
            request_id=request_id,
        ))
        self.cancel_active_events(db, contact, completed=True)
        contact.last_contacted_at = contacted
        contact.next_followup_at = next_followup_time(contact, contacted)
        contact.status = "active"
        contact.revision += 1
        contact.updated_at = utc_now()
        self.schedule_event(db, contact)
        self.audit(db, user_id, contact.id, "contact.contacted", request_id, {"channel": channel or contact.preferred_channel})
        db.commit()
        db.refresh(contact)
        return contact

    def current_event(self, db: Session, contact: RelationshipContact) -> RelationshipFollowupEvent:
        event = db.scalar(select(RelationshipFollowupEvent).where(
            RelationshipFollowupEvent.user_id == contact.user_id,
            RelationshipFollowupEvent.relationship_contact_id == contact.id,
            RelationshipFollowupEvent.status.in_(ACTIVE_EVENT_STATUSES),
        ).order_by(RelationshipFollowupEvent.scheduled_at.asc()).with_for_update())
        if not event:
            raise HTTPException(status_code=409, detail="No active reminder is available for this follow-up.")
        return event

    def reschedule(self, db: Session, user_id: str, contact_id: str, revision: int, request_id: str, scheduled_at: datetime, *, snooze: bool = False) -> RelationshipContact:
        event_type = "reminder.snoozed" if snooze else "reminder.rescheduled"
        contact = self.owned(db, user_id, contact_id, lock=True)
        duplicate = db.scalar(select(RelationshipAuditEvent).where(
            RelationshipAuditEvent.user_id == user_id,
            RelationshipAuditEvent.request_id == request_id,
            RelationshipAuditEvent.event_type == event_type,
        ))
        if duplicate:
            return contact
        self.assert_revision(contact, revision)
        target = utc_naive(scheduled_at)
        if target <= utc_now():
            raise HTTPException(status_code=422, detail="Reminder time must be in the future.")
        self.cancel_active_events(db, contact)
        contact.next_followup_at = target
        contact.status = "active"
        contact.revision += 1
        contact.updated_at = utc_now()
        event = self.schedule_event(db, contact)
        if snooze:
            event.status = "snoozed"
            event.snoozed_until = target
        self.audit(db, user_id, contact.id, event_type, request_id, {"scheduled_at": target.isoformat()})
        db.commit()
        db.refresh(contact)
        return contact

    @staticmethod
    def preferences(db: Session, user_id: str) -> RelationshipNotificationPreference:
        item = db.scalar(select(RelationshipNotificationPreference).where(RelationshipNotificationPreference.user_id == user_id))
        if not item:
            item = RelationshipNotificationPreference(user_id=user_id)
            db.add(item)
            db.commit()
            db.refresh(item)
        return item

    @staticmethod
    def summary(db: Session, user_id: str) -> dict[str, object]:
        now = utc_now()
        contacts = list(db.scalars(select(RelationshipContact).where(RelationshipContact.user_id == user_id)).all())
        buckets = [due_bucket_for(contact, now) for contact in contacts]
        active_due = [contact.next_followup_at for contact in contacts if contact.status == "active"]
        next_due = min(active_due) if active_due else None
        overdue = buckets.count("overdue")
        today = buckets.count("today")
        return {
            "overdue": overdue,
            "today": today,
            "upcoming": buckets.count("upcoming"),
            "recently_contacted": sum(bool(contact.last_contacted_at and contact.last_contacted_at >= now - timedelta(days=30)) for contact in contacts),
            "paused": buckets.count("paused"),
            "archived": buckets.count("archived"),
            "unread_due": overdue + today,
            "next_due_at": utc_aware(next_due),
        }


relationship_followup_service = RelationshipFollowupService()
