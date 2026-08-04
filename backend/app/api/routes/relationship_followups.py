from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.relationship_followup import RelationshipAuditEvent, RelationshipFollowupEvent
from app.models.user import User
from app.schemas.relationship_followup import (
    AiSuggestionRead,
    AiSuggestionRequest,
    ContactAction,
    ContactCreate,
    ContactDetail,
    ContactPage,
    ContactRead,
    ContactUpdate,
    FollowupSummary,
    InteractionRead,
    MarkContacted,
    NotificationPreferenceRead,
    NotificationPreferenceUpdate,
    RescheduleRequest,
    SnoozeRequest,
)
from app.services.groq_service import groq_service
from app.services.relationship_followup_service import contact_json, interaction_json, relationship_followup_service, utc_aware


router = APIRouter(prefix="/relationship-followups", tags=["relationship-followups"])


@router.get("", response_model=ContactPage)
def list_contacts(
    query: str = Query(default="", max_length=80),
    relationship_type: Literal["family", "friend", "relative", "mentor", "colleague", "professional", "other"] | None = None,
    priority: Literal["normal", "important", "high"] | None = None,
    bucket: Literal["overdue", "today", "upcoming", "recent", "paused", "archived"] | None = None,
    sort: Literal["due_asc", "due_desc"] = "due_asc",
    page: int = Query(default=1, ge=1, le=10000),
    limit: int = Query(default=30, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ContactPage:
    items, total = relationship_followup_service.list_contacts(
        db,
        user.id,
        query=query.strip(),
        relationship_type=relationship_type,
        priority=priority,
        bucket=bucket,
        sort=sort,
        page=page,
        limit=limit,
    )
    return ContactPage(items=[ContactRead(**contact_json(item)) for item in items], page=page, limit=limit, total=total, has_more=page * limit < total)


@router.get("/summary", response_model=FollowupSummary)
def summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> FollowupSummary:
    return FollowupSummary(**relationship_followup_service.summary(db, user.id))


@router.get("/preferences", response_model=NotificationPreferenceRead)
def get_preferences(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> NotificationPreferenceRead:
    item = relationship_followup_service.preferences(db, user.id)
    return NotificationPreferenceRead(enabled=item.enabled, detailed_preview=item.detailed_preview, permission_state=item.permission_state, updated_at=utc_aware(item.updated_at))


@router.put("/preferences", response_model=NotificationPreferenceRead)
def update_preferences(payload: NotificationPreferenceUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> NotificationPreferenceRead:
    if payload.enabled and payload.permission_state in {"denied", "permanent_denial"}:
        raise HTTPException(status_code=422, detail="Notification permission is denied. In-app reminders remain available.")
    item = relationship_followup_service.preferences(db, user.id)
    item.enabled = payload.enabled
    item.detailed_preview = payload.detailed_preview
    item.permission_state = payload.permission_state
    item.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(item)
    return NotificationPreferenceRead(enabled=item.enabled, detailed_preview=item.detailed_preview, permission_state=item.permission_state, updated_at=utc_aware(item.updated_at))


@router.post("", response_model=ContactRead, status_code=status.HTTP_201_CREATED)
def create_contact(payload: ContactCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return ContactRead(**contact_json(relationship_followup_service.create(db, user.id, payload)))


@router.get("/{contact_id}", response_model=ContactDetail)
def contact_detail(contact_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactDetail:
    return ContactDetail(**relationship_followup_service.detail(db, user.id, contact_id[:64]))


@router.patch("/{contact_id}", response_model=ContactRead)
def update_contact(contact_id: str, payload: ContactUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return ContactRead(**contact_json(relationship_followup_service.update(db, user.id, contact_id[:64], payload)))


@router.get("/{contact_id}/history", response_model=list[InteractionRead])
def contact_history(contact_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[InteractionRead]:
    detail = relationship_followup_service.detail(db, user.id, contact_id[:64])
    return [InteractionRead(**item) for item in detail["interactions"]]


@router.post("/{contact_id}/contacted", response_model=ContactRead)
def mark_contacted(contact_id: str, payload: MarkContacted, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    item = relationship_followup_service.mark_contacted(
        db, user.id, contact_id[:64], payload.revision, payload.request_id, payload.contacted_at, payload.channel, payload.note
    )
    return ContactRead(**contact_json(item))


@router.post("/{contact_id}/snooze", response_model=ContactRead)
def snooze(contact_id: str, payload: SnoozeRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    scheduled = datetime.now(timezone.utc) + timedelta(minutes=payload.minutes)
    item = relationship_followup_service.reschedule(db, user.id, contact_id[:64], payload.revision, payload.request_id, scheduled, snooze=True)
    return ContactRead(**contact_json(item))


@router.post("/{contact_id}/reschedule", response_model=ContactRead)
def reschedule(contact_id: str, payload: RescheduleRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    item = relationship_followup_service.reschedule(db, user.id, contact_id[:64], payload.revision, payload.request_id, payload.scheduled_at)
    return ContactRead(**contact_json(item))


def status_action(contact_id: str, payload: ContactAction, new_status: str, db: Session, user: User) -> ContactRead:
    item = relationship_followup_service.set_status(db, user.id, contact_id[:64], payload.revision, payload.request_id, new_status)
    return ContactRead(**contact_json(item))


@router.post("/{contact_id}/pause", response_model=ContactRead)
def pause(contact_id: str, payload: ContactAction, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return status_action(contact_id, payload, "paused", db, user)


@router.post("/{contact_id}/resume", response_model=ContactRead)
def resume(contact_id: str, payload: ContactAction, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return status_action(contact_id, payload, "active", db, user)


@router.post("/{contact_id}/archive", response_model=ContactRead)
def archive(contact_id: str, payload: ContactAction, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return status_action(contact_id, payload, "archived", db, user)


@router.post("/{contact_id}/restore", response_model=ContactRead)
def restore(contact_id: str, payload: ContactAction, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    return status_action(contact_id, payload, "active", db, user)


@router.post("/{contact_id}/retry", response_model=ContactRead)
def retry_failed(contact_id: str, payload: ContactAction, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> ContactRead:
    contact = relationship_followup_service.owned(db, user.id, contact_id[:64], lock=True)
    existing_audit = db.scalar(select(RelationshipAuditEvent).where(
        RelationshipAuditEvent.user_id == user.id,
        RelationshipAuditEvent.request_id == payload.request_id,
        RelationshipAuditEvent.event_type == "reminder.retry",
    ))
    if existing_audit:
        return ContactRead(**contact_json(contact))
    relationship_followup_service.assert_revision(contact, payload.revision)
    event = db.scalar(select(RelationshipFollowupEvent).where(
        RelationshipFollowupEvent.user_id == user.id,
        RelationshipFollowupEvent.relationship_contact_id == contact.id,
        RelationshipFollowupEvent.status == "failed",
    ).order_by(RelationshipFollowupEvent.updated_at.desc()).with_for_update())
    if not event:
        raise HTTPException(status_code=409, detail="No failed reminder is available to retry.")
    relationship_followup_service.audit(db, user.id, contact.id, "reminder.retry", payload.request_id)
    event.status = "pending"
    event.attempt_count = 0
    event.next_attempt_at = datetime.utcnow()
    event.failure_code = None
    contact.revision += 1
    db.commit()
    db.refresh(contact)
    return ContactRead(**contact_json(contact))


@router.post("/{contact_id}/ai-suggestion", response_model=AiSuggestionRead)
def ai_suggestion(contact_id: str, payload: AiSuggestionRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> AiSuggestionRead:
    contact = relationship_followup_service.owned(db, user.id, contact_id[:64])
    language = "Hindi" if payload.language == "hi" else "English"
    messages = [
        {
            "role": "system",
            "content": (
                "Write one respectful relationship follow-up message. Use only the supplied facts, never invent personal facts, "
                "return message text only, and keep it under 70 words. The user will edit and send it manually."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Language: {language}\nTone: {payload.tone}\nRelationship: {contact.relationship_type}\n"
                f"Person name: {contact.display_name}\nUser-provided context: {payload.context or 'none'}"
            ),
        },
    ]
    text, _, model = groq_service.complete(
        messages,
        provider=settings.AI_PROVIDER,
        temperature=0.2,
        max_tokens=180,
        request_timeout=min(settings.GROQ_REQUEST_TIMEOUT_SECONDS, 15),
    )
    suggestion = text.strip().strip('"').strip()
    if not suggestion:
        raise HTTPException(status_code=502, detail="The AI provider returned an empty suggestion. Please write the message manually.")
    return AiSuggestionRead(suggestion=suggestion[:800], model=model)
