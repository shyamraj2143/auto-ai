from __future__ import annotations

import hashlib
import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.form_service import ServiceAuditEvent, ServiceTask, TaskStateTransition
from app.schemas.form_service import TaskState


TERMINAL_STATES = {TaskState.COMPLETED_VERIFIED, TaskState.FAILED_FINAL, TaskState.CANCELLED, TaskState.EXPIRED}

LEGAL_TRANSITIONS: dict[TaskState, set[TaskState]] = {
    TaskState.CREATED: {TaskState.INTENT_CONFIRMED, TaskState.PAUSED, TaskState.CANCELLED, TaskState.EXPIRED},
    TaskState.INTENT_CONFIRMED: {TaskState.SERVICE_DISCOVERY, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.SERVICE_DISCOVERY: {TaskState.REQUIREMENTS_READY, TaskState.FAILED_RECOVERABLE, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.REQUIREMENTS_READY: {TaskState.COLLECTING_INFORMATION, TaskState.COLLECTING_DOCUMENTS, TaskState.READY_TO_PREPARE, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.COLLECTING_INFORMATION: {TaskState.COLLECTING_DOCUMENTS, TaskState.READY_TO_PREPARE, TaskState.PAUSED, TaskState.CANCELLED, TaskState.FAILED_RECOVERABLE},
    TaskState.COLLECTING_DOCUMENTS: {TaskState.AWAITING_PERMISSION, TaskState.READY_TO_PREPARE, TaskState.PAUSED, TaskState.CANCELLED, TaskState.FAILED_RECOVERABLE},
    TaskState.AWAITING_PERMISSION: {TaskState.COLLECTING_DOCUMENTS, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.AWAITING_AUTHENTICATION: {TaskState.PORTAL_SESSION_ACTIVE, TaskState.REVIEW_REQUIRED, TaskState.AWAITING_USER_ACTION, TaskState.FAILED_RECOVERABLE, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.READY_TO_PREPARE: {TaskState.PREPARING, TaskState.COLLECTING_DOCUMENTS, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.PREPARING: {TaskState.VALIDATING, TaskState.FAILED_RECOVERABLE, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.PORTAL_SESSION_ACTIVE: {TaskState.AWAITING_AUTHENTICATION, TaskState.AWAITING_USER_ACTION, TaskState.VALIDATING, TaskState.SUBMITTED_UNVERIFIED, TaskState.PAUSED, TaskState.CANCELLED, TaskState.FAILED_RECOVERABLE, TaskState.FAILED_FINAL},
    TaskState.AWAITING_USER_ACTION: {TaskState.PORTAL_SESSION_ACTIVE, TaskState.VALIDATING, TaskState.SUBMITTED_UNVERIFIED, TaskState.PAUSED, TaskState.CANCELLED, TaskState.FAILED_RECOVERABLE, TaskState.FAILED_FINAL},
    TaskState.VALIDATING: {TaskState.REVIEW_REQUIRED, TaskState.AWAITING_AUTHENTICATION, TaskState.COLLECTING_INFORMATION, TaskState.COLLECTING_DOCUMENTS, TaskState.FAILED_RECOVERABLE, TaskState.PAUSED},
    TaskState.REVIEW_REQUIRED: {TaskState.COLLECTING_INFORMATION, TaskState.COLLECTING_DOCUMENTS, TaskState.SUBMISSION_CONFIRMATION_REQUIRED, TaskState.PORTAL_SESSION_ACTIVE, TaskState.AWAITING_AUTHENTICATION, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.SUBMISSION_CONFIRMATION_REQUIRED: {TaskState.SUBMITTING, TaskState.REVIEW_REQUIRED, TaskState.PORTAL_SESSION_ACTIVE, TaskState.AWAITING_AUTHENTICATION, TaskState.CANCELLED, TaskState.PAUSED},
    TaskState.SUBMITTING: {TaskState.SUBMITTED_UNVERIFIED, TaskState.VERIFYING, TaskState.FAILED_RECOVERABLE, TaskState.FAILED_FINAL},
    TaskState.SUBMITTED_UNVERIFIED: {TaskState.VERIFYING, TaskState.FAILED_RECOVERABLE, TaskState.PAUSED},
    TaskState.VERIFYING: {TaskState.COMPLETED_VERIFIED, TaskState.SUBMITTED_UNVERIFIED, TaskState.FAILED_RECOVERABLE},
    TaskState.FAILED_RECOVERABLE: {TaskState.READY_TO_PREPARE, TaskState.PORTAL_SESSION_ACTIVE, TaskState.AWAITING_AUTHENTICATION, TaskState.VERIFYING, TaskState.PAUSED, TaskState.CANCELLED},
    TaskState.PAUSED: set(TaskState) - TERMINAL_STATES - {TaskState.PAUSED, TaskState.CREATED},
    TaskState.COMPLETED_VERIFIED: set(),
    TaskState.FAILED_FINAL: set(),
    TaskState.CANCELLED: set(),
    TaskState.EXPIRED: set(),
}


class InvalidTaskTransition(ValueError):
    pass


def append_audit_event(
    db: Session,
    task: ServiceTask,
    event_type: str,
    details: dict,
    request_id: str,
) -> ServiceAuditEvent:
    previous = db.scalar(
        select(ServiceAuditEvent)
        .where(ServiceAuditEvent.user_id == task.user_id)
        .order_by(ServiceAuditEvent.created_at.desc(), ServiceAuditEvent.id.desc())
        .limit(1)
    )
    previous_hash = previous.event_hash if previous else ""
    safe_details = {key: value for key, value in details.items() if not any(secret in key.casefold() for secret in ("password", "otp", "pin", "secret", "token", "cvv"))}
    canonical = json.dumps(
        {"task": task.id, "type": event_type, "details": safe_details, "request_id": request_id, "previous": previous_hash},
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    event = ServiceAuditEvent(
        task_id=task.id,
        user_id=task.user_id,
        event_type=event_type,
        details=safe_details,
        previous_hash=previous_hash,
        event_hash=hashlib.sha256(canonical.encode()).hexdigest(),
        request_id=request_id,
    )
    db.add(event)
    return event


def transition_task(
    db: Session,
    task: ServiceTask,
    new_state: TaskState,
    *,
    actor: str,
    source: str,
    reason: str,
    request_id: str,
    evidence_reference: str | None = None,
) -> None:
    previous = TaskState(task.state)
    if new_state == previous:
        return
    if new_state not in LEGAL_TRANSITIONS.get(previous, set()):
        raise InvalidTaskTransition(f"Transition {previous.value} → {new_state.value} is not allowed")
    task.state = new_state.value
    task.version += 1
    task.updated_at = datetime.utcnow()
    db.add(
        TaskStateTransition(
            task_id=task.id,
            user_id=task.user_id,
            actor=actor,
            source=source,
            previous_state=previous.value,
            new_state=new_state.value,
            reason=reason,
            request_id=request_id,
            evidence_reference=evidence_reference,
        )
    )
    append_audit_event(
        db,
        task,
        "TASK_STATE_CHANGED",
        {
            "previous_state": previous.value,
            "new_state": new_state.value,
            "actor": actor,
            "source": source,
            "reason": reason,
            "progress_percent": task.progress_percent,
            "evidence_reference": evidence_reference,
        },
        request_id,
    )
