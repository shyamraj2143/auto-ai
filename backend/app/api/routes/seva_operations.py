from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_admin, get_current_user
from app.api.routes.auth import ensure_user_can_authenticate, issue_session
from app.core.security import get_password_hash, verify_password
from app.db.session import get_db
from app.models.admin_control import AuditLog
from app.models.autoai_seva import SevaAgentProfile, SevaAssignment, SevaCaseEvent, SevaDeliverable, SevaNotification, SevaQualityReview, SevaRequirementRequest, SevaWorkOrder
from app.models.document import Document
from app.models.form_service import (
    HumanHandoff,
    PortalAdapterRecord,
    ServiceDefinition,
    ServiceDocumentAsset,
    ServiceTask,
    UserFieldResponse,
)
from app.models.user import User
from app.schemas.form_service import ExecutionMode
from app.services.autoai_seva_seed import ASSISTED_REQUEST_SERVICE_ID, ensure_autoai_seva_demo
from app.services.form_service_documents import inspect_and_store_upload
from app.services.form_service_registry import (
    RegistryResolution,
    ensure_service_registry,
    resolve_service,
    search_service_candidates,
    service_catalogue_payload,
)
from app.services.form_service_service import (
    build_task_view,
    create_handoff,
    create_task,
    get_owned_task,
    service_error,
    start_task,
)
from app.services.form_service_state import append_audit_event
from app.services.seva_assignment import ACTIVE_STATES, assign_best_available_agent, assign_waiting_work, case_event, notify, queue_position


router = APIRouter(prefix="/seva-operations", tags=["autoai-seva-operations"])

SECRET_WORDS = (
    "password", "passcode", "otp", "pin", "captcha", "cvv", "secret", "token",
    "recovery code", "credential", "authentication code", "verification code", "one-time code",
    "पासवर्ड", "ओटीपी", "पिन", "कैप्चा", "सीवीवी",
)
TERMINAL_WORK_ORDER_STATES = {"COMPLETED", "DELIVERED", "REJECTED", "CANCELLED"}
ALLOWED_WORK_ORDER_TRANSITIONS = {
    "QUEUED": {"IN_PROGRESS", "ESCALATED", "CANCELLED"},
    "IN_PROGRESS": {"WAITING_USER", "DOCUMENT_VERIFICATION", "PROTECTED_ACTION_REQUIRED", "QUALITY_REVIEW", "READY_TO_SUBMIT", "ESCALATED", "CANCELLED"},
    "WAITING_USER": {"IN_PROGRESS", "PROTECTED_ACTION_REQUIRED", "ESCALATED", "CANCELLED"},
    "DOCUMENT_VERIFICATION": {"IN_PROGRESS", "WAITING_USER", "QUALITY_REVIEW", "READY_TO_SUBMIT", "ESCALATED", "CANCELLED"},
    "PROTECTED_ACTION_REQUIRED": {"IN_PROGRESS", "WAITING_USER", "READY_TO_SUBMIT", "ESCALATED", "CANCELLED"},
    "QUALITY_REVIEW": {"IN_PROGRESS", "READY_TO_SUBMIT", "ESCALATED", "CANCELLED"},
    "READY_TO_SUBMIT": {"SUBMITTED", "SUBMITTED_TO_AUTHORITY", "PROTECTED_ACTION_REQUIRED", "ESCALATED", "CANCELLED"},
    "SUBMITTED": {"UNDER_AUTHORITY_PROCESSING", "APPROVED", "REJECTED", "ISSUED", "IN_PROGRESS", "ESCALATED", "CANCELLED"},
    "SUBMITTED_TO_AUTHORITY": {"UNDER_AUTHORITY_PROCESSING", "APPROVED", "REJECTED", "ISSUED", "ESCALATED", "CANCELLED"},
    "UNDER_AUTHORITY_PROCESSING": {"APPROVED", "REJECTED", "ISSUED", "ESCALATED", "CANCELLED"},
    "APPROVED": {"ISSUED", "DELIVERED", "ESCALATED"},
    "ISSUED": {"DELIVERED", "ESCALATED"},
    "ESCALATED": {"IN_PROGRESS", "WAITING_USER", "QUALITY_REVIEW", "READY_TO_SUBMIT", "SUBMITTED_TO_AUTHORITY", "CANCELLED"},
}


class SevaStartRequest(BaseModel):
    query: str = Field(min_length=3, max_length=1000)
    service_id: str | None = Field(default=None, min_length=3, max_length=80)
    timezone: str = Field(default="Asia/Kolkata", max_length=100)
    locale: str = Field(default="hi-IN", max_length=35)
    client_request_id: str = Field(min_length=8, max_length=120)


class SevaDiscoverRequest(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    limit: int = Field(default=5, ge=1, le=10)


class AssistanceCreateRequest(BaseModel):
    purpose: str = Field(default="Help me complete this application safely", min_length=3, max_length=500)
    consent_accepted: bool


class RequirementCreateRequest(BaseModel):
    kind: Literal["TEXT", "DOCUMENT", "PROTECTED_ACTION"]
    label: str = Field(min_length=2, max_length=180)
    instructions: str = Field(default="", max_length=1000)
    field_key: str | None = Field(default=None, max_length=100)
    required: bool = True

    @field_validator("label", "instructions", "field_key")
    @classmethod
    def reject_secret_collection_labels(cls, value: str | None) -> str | None:
        if value and any(word in value.casefold() for word in SECRET_WORDS):
            # Secret-related requirements must be protected actions, never text/document responses.
            return value
        return value


class RequirementTextResponse(BaseModel):
    value: str = Field(min_length=1, max_length=2000)
    note: str | None = Field(default=None, max_length=500)

    @field_validator("value", "note")
    @classmethod
    def reject_secrets(cls, value: str | None) -> str | None:
        if value and any(word in value.casefold() for word in SECRET_WORDS):
            raise ValueError("Authentication secrets cannot be sent to an employee")
        return value


class ProtectedActionResponse(BaseModel):
    completed: bool
    note: str | None = Field(default=None, max_length=500)


class WorkOrderStatusRequest(BaseModel):
    status: Literal[
        "QUEUED", "IN_PROGRESS", "WAITING_USER", "DOCUMENT_VERIFICATION",
        "PROTECTED_ACTION_REQUIRED", "QUALITY_REVIEW", "READY_TO_SUBMIT", "SUBMITTED",
        "SUBMITTED_TO_AUTHORITY", "UNDER_AUTHORITY_PROCESSING", "APPROVED", "REJECTED",
        "ISSUED", "DELIVERED", "ESCALATED", "COMPLETED", "CANCELLED",
    ]
    note: str | None = Field(default=None, max_length=2000)
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    reference_number: str | None = Field(default=None, max_length=120)


class QualityReviewRequest(BaseModel):
    approved: bool
    reason: str | None = Field(default=None, max_length=1000)

    @field_validator("reason")
    @classmethod
    def require_return_reason(cls, value: str | None, info):
        if info.data.get("approved") is False and not (value or "").strip():
            raise ValueError("A correction reason is required when returning a case")
        return value


class EscalationRequest(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class RequirementReviewRequest(BaseModel):
    accepted: bool
    note: str | None = Field(default=None, max_length=500)


class AgentLoginRequest(BaseModel):
    agent_id: str = Field(min_length=3, max_length=48, pattern=r"^[A-Za-z0-9._-]+$")
    password: str = Field(min_length=1, max_length=128)


class AgentCreateRequest(BaseModel):
    agent_id: str = Field(min_length=3, max_length=48, pattern=r"^[A-Za-z0-9._-]+$")
    display_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=128)
    capacity: int = Field(default=5, ge=1, le=50)
    work_email: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=32)
    specializations: list[str] = Field(default_factory=list, max_length=30)
    languages: list[str] = Field(default_factory=list, max_length=20)


class AgentUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    capacity: int | None = Field(default=None, ge=1, le=50)
    is_active: bool | None = None
    status: Literal["ACTIVE", "INACTIVE", "SUSPENDED"] | None = None
    work_email: str | None = Field(default=None, max_length=255)
    contact_phone: str | None = Field(default=None, max_length=32)
    specializations: list[str] | None = None
    languages: list[str] | None = None


class AgentPasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class ReassignRequest(BaseModel):
    agent_profile_id: str | None = None
    reason: str = Field(min_length=3, max_length=240)


def _agent_profile(db: Session, user: User) -> SevaAgentProfile | None:
    return db.scalar(select(SevaAgentProfile).where(SevaAgentProfile.user_id == user.id))


def get_current_seva_employee(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    if user.is_admin and user.role in {"admin", "super_admin", "administrator"}:
        return user
    profile = _agent_profile(db, user)
    if not profile or not profile.is_active or profile.status != "ACTIVE" or user.role != "seva_agent":
        raise HTTPException(status_code=403, detail="Active Seva agent access required")
    if profile.must_change_password:
        raise HTTPException(status_code=403, detail="Change your temporary password before opening cases")
    return user


def _agent_view(db: Session, profile: SevaAgentProfile) -> dict:
    active_load = int(db.scalar(select(func.count()).select_from(SevaWorkOrder).where(
        SevaWorkOrder.assigned_employee_id == profile.user_id,
        SevaWorkOrder.status.in_(ACTIVE_STATES),
    )) or 0)
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "agent_id": profile.agent_code,
        "display_name": profile.display_name,
        "username": (db.get(User, profile.user_id).username if db.get(User, profile.user_id) else profile.agent_code),
        "work_email": profile.work_email,
        "contact_phone": profile.contact_phone,
        "specializations": profile.specializations or [],
        "languages": profile.languages or [],
        "capacity": profile.capacity,
        "active_load": active_load,
        "available_slots": max(0, profile.capacity - active_load) if profile.is_active else 0,
        "is_active": profile.is_active,
        "status": profile.status,
        "must_change_password": profile.must_change_password,
        "last_assigned_at": profile.last_assigned_at,
        "last_login_at": profile.last_login_at,
        "created_at": profile.created_at,
    }


def _safe_document(document: Document | None) -> dict | None:
    if not document:
        return None
    return {
        "id": document.id,
        "filename": document.filename,
        "content_type": document.content_type,
        "file_size": document.file_size,
    }


def _work_order_view(db: Session, work_order: SevaWorkOrder, *, include_owner: bool = False) -> dict:
    task = db.get(ServiceTask, work_order.task_id)
    service = db.get(ServiceDefinition, task.service_id) if task else None
    employee = db.get(User, work_order.assigned_employee_id) if work_order.assigned_employee_id else None
    owner = db.get(User, work_order.user_id) if include_owner else None
    requirements = list(
        db.scalars(
            select(SevaRequirementRequest)
            .where(SevaRequirementRequest.work_order_id == work_order.id)
            .order_by(SevaRequirementRequest.requested_at)
        )
    )
    deliverables = list(
        db.scalars(
            select(SevaDeliverable)
            .where(SevaDeliverable.work_order_id == work_order.id)
            .order_by(SevaDeliverable.created_at.desc())
        )
    )
    fulfilled = sum(item.status in {"FULFILLED", "ACCEPTED"} for item in requirements)
    progress_by_status = {
        "QUEUED": 10, "IN_PROGRESS": 25, "WAITING_USER": 45,
        "DOCUMENT_VERIFICATION": 50, "PROTECTED_ACTION_REQUIRED": 65,
        "QUALITY_REVIEW": 72, "READY_TO_SUBMIT": 80, "ESCALATED": 60,
        "SUBMITTED": 90, "SUBMITTED_TO_AUTHORITY": 90,
        "UNDER_AUTHORITY_PROCESSING": 92, "APPROVED": 95, "REJECTED": 100,
        "ISSUED": 98, "DELIVERED": 100, "COMPLETED": 100, "CANCELLED": 0,
    }
    work_progress = 100 if work_order.status in {"COMPLETED", "DELIVERED", "REJECTED"} else max(work_order.progress_percent or 0, progress_by_status.get(work_order.status, 10))
    if work_order.status == "IN_PROGRESS" and requirements:
        work_progress = max(work_progress, min(85, 35 + round(fulfilled / len(requirements) * 45)))
    event_query = select(SevaCaseEvent).where(SevaCaseEvent.work_order_id == work_order.id)
    if not include_owner:
        event_query = event_query.where(SevaCaseEvent.visibility == "USER")
    events = list(db.scalars(event_query.order_by(SevaCaseEvent.created_at.desc()).limit(100)))
    assignments = list(db.scalars(select(SevaAssignment).where(SevaAssignment.work_order_id == work_order.id).order_by(SevaAssignment.assigned_at))) if include_owner else []
    quality_reviews = list(db.scalars(select(SevaQualityReview).where(SevaQualityReview.work_order_id == work_order.id).order_by(SevaQualityReview.requested_at)))
    sla_status = work_order.sla_status
    if work_order.due_at and work_order.due_at < datetime.utcnow() and work_order.status not in TERMINAL_WORK_ORDER_STATES:
        sla_status = "OVERDUE" if sla_status != "ESCALATED" else sla_status
    return {
        "id": work_order.id,
        "case_id": work_order.case_number or f"SEVA-{work_order.created_at.year}-{work_order.id[:8].upper()}",
        "task_id": work_order.task_id,
        "handoff_id": work_order.handoff_id,
        "status": work_order.status,
        "priority": work_order.priority,
        "department": work_order.department,
        "queue_name": work_order.queue_name,
        "request_summary": work_order.request_summary,
        "employee_note": work_order.employee_note,
        "assigned_employee": ({"id": employee.id, "name": employee.name} if employee else None),
        "owner": ({"id": owner.id, "name": owner.name, "email": owner.email, "phone_number": owner.phone_number} if owner else None),
        "service": ({"id": service.id, "name": service.name, "provider": service.provider} if service else None),
        "task_state": task.state if task else None,
        "task_progress": task.progress_percent if task else 0,
        "work_progress": work_progress,
        "current_activity": work_order.current_activity or work_order.employee_note or work_order.status.replace("_", " ").title(),
        "reference_number": work_order.reference_number,
        "official_status": work_order.official_status,
        "sla_status": sla_status,
        "escalation_reason": work_order.escalation_reason,
        "escalated_at": work_order.escalated_at,
        "quality_required": work_order.quality_required,
        "quality_status": work_order.quality_status,
        "quality_reviews": [
            {
                "id": item.id,
                "status": item.status,
                "snapshot_version": item.snapshot_version,
                "decision_reason": item.decision_reason,
                "requested_by_user_id": item.requested_by_user_id,
                "reviewer_user_id": item.reviewer_user_id,
                "requested_at": item.requested_at,
                "reviewed_at": item.reviewed_at,
            }
            for item in quality_reviews
        ],
        "submitted_at": work_order.submitted_at or work_order.created_at,
        "due_at": work_order.due_at,
        "queue_position": queue_position(db, work_order),
        "consent_scope": work_order.user_consent_scope,
        "requirements": [
            {
                "id": item.id,
                "kind": item.kind,
                "field_key": item.field_key,
                "label": item.label,
                "instructions": item.instructions,
                "required": item.required,
                "protected_action": item.protected_action,
                "status": item.status,
                "response_text": item.response_text if item.kind == "TEXT" else None,
                "response_document": _safe_document(db.get(Document, item.response_document_id)) if item.response_document_id else None,
                "user_note": item.user_note,
                "requested_at": item.requested_at,
                "responded_at": item.responded_at,
                "reviewed_at": item.reviewed_at,
            }
            for item in requirements
        ],
        "deliverables": [
            {
                "id": item.id,
                "kind": item.kind,
                "label": item.label,
                "note": item.note,
                "verified_by_employee": item.verified_by_employee,
                "document": _safe_document(db.get(Document, item.document_id)),
                "created_at": item.created_at,
            }
            for item in deliverables
        ],
        "timeline": [{"id": item.id, "event_type": item.event_type, "title": item.title, "details": item.details, "created_at": item.created_at} for item in reversed(events)],
        "assignment_history": [{"id": item.id, "agent_user_id": item.agent_user_id, "reason": item.reason, "assigned_at": item.assigned_at, "ended_at": item.ended_at, "ended_reason": item.ended_reason} for item in assignments],
        "claimed_at": work_order.claimed_at,
        "completed_at": work_order.completed_at,
        "created_at": work_order.created_at,
        "updated_at": work_order.updated_at,
    }


@router.post("/agent/login")
def login_seva_agent(payload: AgentLoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    code = payload.agent_id.strip().lower()
    profile = db.scalar(select(SevaAgentProfile).where(SevaAgentProfile.agent_code == code))
    user = db.get(User, profile.user_id) if profile else None
    if not profile or not profile.is_active or profile.status != "ACTIVE" or not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Agent ID or password is incorrect")
    ensure_user_can_authenticate(user)
    profile.last_login_at = datetime.utcnow()
    session = issue_session(db, user, request, response)
    return {**session.model_dump(mode="json"), "agent": _agent_view(db, profile)}


@router.get("/agent/me")
def seva_agent_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = _agent_profile(db, user)
    if not profile or user.role != "seva_agent":
        raise HTTPException(status_code=403, detail="Seva agent access required")
    return _agent_view(db, profile)


@router.post("/agent/change-password")
def change_seva_agent_password(payload: AgentPasswordChangeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = _agent_profile(db, user)
    if not profile or user.role != "seva_agent" or not profile.is_active or profile.status != "ACTIVE":
        raise HTTPException(status_code=403, detail="Active Seva agent access required")
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if verify_password(payload.new_password, user.hashed_password):
        raise HTTPException(status_code=422, detail="Choose a different password")
    user.hashed_password = get_password_hash(payload.new_password)
    profile.must_change_password = False
    db.add(AuditLog(actor_user_id=user.id, target_user_id=user.id, action="seva.agent.password_changed", reason="Agent changed temporary password", audit_metadata={"agent_code": profile.agent_code}))
    db.commit()
    return {"ok": True}


@router.get("/admin/agents")
def list_seva_agents(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    del admin
    profiles = list(db.scalars(select(SevaAgentProfile).order_by(SevaAgentProfile.created_at.desc())))
    items = [_agent_view(db, item) for item in profiles]
    return {"items": items, "total": len(items), "summary": {
        "active": sum(item["status"] == "ACTIVE" for item in items),
        "inactive": sum(item["status"] == "INACTIVE" for item in items),
        "suspended": sum(item["status"] == "SUSPENDED" for item in items),
        "at_capacity": sum(item["is_active"] and item["available_slots"] == 0 for item in items),
    }}


@router.post("/admin/agents", status_code=status.HTTP_201_CREATED)
def create_seva_agent(payload: AgentCreateRequest, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    code = payload.agent_id.strip().lower()
    user = User(
        email=f"{code}@agents.autoai.site.je",
        username=code,
        name=payload.display_name.strip(),
        hashed_password=get_password_hash(payload.password),
        provider="seva_agent",
        is_active=True,
        is_admin=False,
        role="seva_agent",
        subscription_status="active",
    )
    db.add(user)
    try:
        db.flush()
        profile = SevaAgentProfile(
            user_id=user.id,
            agent_code=code,
            display_name=payload.display_name.strip(),
            capacity=payload.capacity,
            work_email=(payload.work_email or "").strip() or None,
            contact_phone=(payload.contact_phone or "").strip() or None,
            specializations=sorted({item.strip().casefold() for item in payload.specializations if item.strip()}),
            languages=sorted({item.strip() for item in payload.languages if item.strip()}),
            created_by_admin_id=admin.id,
        )
        db.add(profile)
        db.flush()
        db.add(AuditLog(actor_user_id=admin.id, target_user_id=user.id, action="seva.agent.created", reason="Administrator created Seva agent", audit_metadata={"agent_code": code, "capacity": payload.capacity, "specializations": profile.specializations}))
        assign_waiting_work(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="This agent ID is already in use") from exc
    db.refresh(profile)
    return _agent_view(db, profile)


@router.patch("/admin/agents/{profile_id}")
def update_seva_agent(profile_id: str, payload: AgentUpdateRequest, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    profile = db.get(SevaAgentProfile, profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail="Seva agent not found")
    user = db.get(User, profile.user_id)
    if payload.display_name is not None:
        profile.display_name = payload.display_name.strip()
        if user:
            user.name = profile.display_name
    if payload.capacity is not None:
        profile.capacity = payload.capacity
    requested_status = payload.status
    if requested_status is None and payload.is_active is not None:
        requested_status = "ACTIVE" if payload.is_active else "INACTIVE"
    if requested_status is not None:
        profile.status = requested_status
        profile.is_active = requested_status == "ACTIVE"
        if user:
            user.is_active = requested_status == "ACTIVE"
        if requested_status != "ACTIVE":
            assigned = list(db.scalars(select(SevaWorkOrder).where(
                SevaWorkOrder.assigned_employee_id == profile.user_id,
                SevaWorkOrder.status.in_(ACTIVE_STATES),
            )))
            for work_order in assigned:
                previous = db.scalar(select(SevaAssignment).where(
                    SevaAssignment.work_order_id == work_order.id,
                    SevaAssignment.agent_user_id == profile.user_id,
                    SevaAssignment.ended_at.is_(None),
                ).order_by(SevaAssignment.assigned_at.desc()))
                if previous:
                    previous.ended_at = datetime.utcnow()
                    previous.ended_reason = f"Agent {requested_status.lower()}"
                work_order.assigned_employee_id = None
                work_order.status = "QUEUED"
                work_order.claimed_at = None
                work_order.current_activity = "Waiting for reassignment"
                work_order.progress_percent = max(5, work_order.progress_percent)
                handoff = db.get(HumanHandoff, work_order.handoff_id)
                if handoff:
                    handoff.status = "APPROVED"
                    handoff.agent_identity = {"status": "UNASSIGNED", "verified": False}
                case_event(db, work_order, "REASSIGNMENT_QUEUED", "Case queued for reassignment", actor_id=admin.id, details={"reason": requested_status})
                notify(db, work_order, work_order.user_id, "AGENT_REASSIGNING", "Assigning another Seva agent", "Your application remains safe in the assignment queue.")
    if payload.work_email is not None:
        profile.work_email = payload.work_email.strip() or None
    if payload.contact_phone is not None:
        profile.contact_phone = payload.contact_phone.strip() or None
    if payload.specializations is not None:
        profile.specializations = sorted({item.strip().casefold() for item in payload.specializations if item.strip()})
    if payload.languages is not None:
        profile.languages = sorted({item.strip() for item in payload.languages if item.strip()})
    if payload.password is not None and user:
        user.hashed_password = get_password_hash(payload.password)
        profile.must_change_password = True
    db.add(AuditLog(actor_user_id=admin.id, target_user_id=profile.user_id, action="seva.agent.updated", reason="Administrator updated Seva agent", audit_metadata={"agent_code": profile.agent_code, "status": profile.status, "capacity": profile.capacity, "password_reset": payload.password is not None}))
    assign_waiting_work(db)
    db.commit()
    db.refresh(profile)
    return _agent_view(db, profile)


@router.get("/notifications")
def list_seva_notifications(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(SevaNotification).where(
        SevaNotification.recipient_user_id == user.id,
    ).order_by(SevaNotification.created_at.desc()).limit(50)))
    return {"items": [{
        "id": item.id, "work_order_id": item.work_order_id, "event_type": item.event_type,
        "title": item.title, "message": item.message, "deep_link": item.deep_link,
        "read_at": item.read_at, "created_at": item.created_at,
    } for item in items], "unread": sum(item.read_at is None for item in items)}


@router.post("/notifications/{notification_id}/read")
def read_seva_notification(notification_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    item = db.scalar(select(SevaNotification).where(
        SevaNotification.id == notification_id, SevaNotification.recipient_user_id == user.id,
    ))
    if not item:
        raise HTTPException(status_code=404, detail="Notification not found")
    item.read_at = item.read_at or datetime.utcnow()
    db.commit()
    return {"ok": True}


def _owned_work_order(db: Session, user_id: str, task_id: str) -> SevaWorkOrder:
    work_order = db.scalar(
        select(SevaWorkOrder).where(
            SevaWorkOrder.task_id == task_id,
            SevaWorkOrder.user_id == user_id,
        )
    )
    if not work_order:
        raise HTTPException(status_code=404, detail="Employee assistance has not been requested")
    return work_order


def _admin_work_order(db: Session, work_order_id: str) -> SevaWorkOrder:
    work_order = db.get(SevaWorkOrder, work_order_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Seva work order not found")
    return work_order


def _require_assigned_employee(work_order: SevaWorkOrder, employee: User) -> None:
    if employee.is_admin:
        if work_order.assigned_employee_id not in {None, employee.id}:
            raise HTTPException(status_code=409, detail="This work order is assigned to another employee")
        return
    if work_order.assigned_employee_id != employee.id:
        raise HTTPException(status_code=409, detail="This work order is assigned to another employee")


def _close_current_assignment(db: Session, work_order: SevaWorkOrder, reason: str) -> None:
    assignment = db.scalar(select(SevaAssignment).where(
        SevaAssignment.work_order_id == work_order.id,
        SevaAssignment.ended_at.is_(None),
    ).order_by(SevaAssignment.assigned_at.desc()))
    if assignment:
        assignment.ended_at = datetime.utcnow()
        assignment.ended_reason = reason[:240]


def _response_requirement(db: Session, work_order: SevaWorkOrder, requirement_id: str) -> SevaRequirementRequest:
    requirement = db.scalar(
        select(SevaRequirementRequest).where(
            SevaRequirementRequest.id == requirement_id,
            SevaRequirementRequest.work_order_id == work_order.id,
        )
    )
    if not requirement:
        raise HTTPException(status_code=404, detail="Requirement request not found")
    return requirement


@router.post("/start", status_code=status.HTTP_201_CREATED)
def start_seva_request(
    payload: SevaStartRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_service_registry(db)
    ensure_autoai_seva_demo(db)
    resolution = None
    fallback = False
    if payload.service_id:
        service = db.get(ServiceDefinition, payload.service_id)
        adapter = db.scalar(
            select(PortalAdapterRecord).where(
                PortalAdapterRecord.service_id == payload.service_id,
                PortalAdapterRecord.enabled.is_(True),
            )
        )
        if not service or not service.active or not adapter:
            raise HTTPException(status_code=404, detail="The confirmed service is not available")
        from app.models.form_service import ServicePortal
        portal = db.scalar(
            select(ServicePortal).where(
                ServicePortal.service_id == service.id,
                ServicePortal.verified.is_(True),
            )
        )
        resolution = RegistryResolution(service=service, portal=portal, adapter=adapter, confidence=1.0)
    else:
        resolution = resolve_service(db, payload.query)
        fallback = resolution is None
    if fallback:
        service = db.get(ServiceDefinition, ASSISTED_REQUEST_SERVICE_ID)
        adapter = db.scalar(
            select(PortalAdapterRecord).where(
                PortalAdapterRecord.service_id == ASSISTED_REQUEST_SERVICE_ID,
                PortalAdapterRecord.enabled.is_(True),
            )
        )
        if not service or not adapter:
            raise HTTPException(status_code=503, detail="AutoAI Seva employee assistance is unavailable")
        resolution = RegistryResolution(service=service, portal=None, adapter=adapter, confidence=1.0)

    mode = (
        ExecutionMode.EXECUTE_WITH_CONFIRMATION
        if resolution.adapter.adapter_type == "local_verified"
        else ExecutionMode.ASSIST
    )
    task = create_task(
        db,
        user.id,
        resolution,
        chat_id=None,
        original_request=payload.query,
        execution_mode=mode,
        timezone=payload.timezone,
        locale=payload.locale,
        client_request_id=payload.client_request_id,
    )
    if task.state == "CREATED":
        start_task(
            db,
            task,
            expected_version=task.version,
            request_id=f"seva-start-{task.id}",
            actor="system",
            source="seva_search",
            reason="AutoAI Seva matched the request and opened the application workspace",
        )
    return {
        "matched": not fallback,
        "fallback_to_employee": fallback,
        "message": (
            "Verified service matched. The exact application form is ready."
            if not fallback
            else "No verified automatic adapter matched. A structured employee-assisted request form is ready."
        ),
        "task": build_task_view(db, task),
    }


@router.post("/discover")
def discover_seva_services(
    payload: SevaDiscoverRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del user
    ensure_service_registry(db)
    ensure_autoai_seva_demo(db)
    candidates = search_service_candidates(db, payload.query, limit=payload.limit)
    if candidates:
        return {
            "query": payload.query,
            "requires_confirmation": True,
            "candidates": candidates,
            "fallback": None,
        }
    fallback = db.get(ServiceDefinition, ASSISTED_REQUEST_SERVICE_ID)
    if not fallback:
        raise HTTPException(status_code=503, detail="AutoAI Seva assistance is unavailable")
    return {
        "query": payload.query,
        "requires_confirmation": True,
        "candidates": [],
        "fallback": service_catalogue_payload(fallback),
    }


@router.get("/catalogue")
def list_seva_catalogue(
    category: str | None = Query(default=None, max_length=60),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del user
    ensure_service_registry(db)
    ensure_autoai_seva_demo(db)
    query = select(ServiceDefinition).where(ServiceDefinition.active.is_(True))
    if category:
        query = query.where(ServiceDefinition.category == category)
    services = list(db.scalars(query.order_by(ServiceDefinition.category, ServiceDefinition.name)))
    items = [service_catalogue_payload(service) for service in services if service.category != "demonstration"]
    return {
        "items": items,
        "categories": sorted({item["category"] for item in items}),
        "total": len(items),
    }


@router.get("/catalogue/{service_id}")
def get_seva_catalogue_service(
    service_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    del user
    ensure_service_registry(db)
    ensure_autoai_seva_demo(db)
    service = db.get(ServiceDefinition, service_id)
    if not service or not service.active:
        raise HTTPException(status_code=404, detail="Service not found")
    from app.models.form_service import ServicePortal
    portal = db.scalar(
        select(ServicePortal).where(
            ServicePortal.service_id == service.id,
            ServicePortal.verified.is_(True),
        )
    )
    return service_catalogue_payload(service, portal)


@router.post("/tasks/{task_id}/assistance", status_code=status.HTTP_201_CREATED)
def request_employee_assistance(
    task_id: str,
    payload: AssistanceCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not payload.consent_accepted:
        raise HTTPException(status_code=422, detail="Approve the scoped employee handoff before continuing")
    task = get_owned_task(db, user.id, task_id)
    existing = db.scalar(select(SevaWorkOrder).where(SevaWorkOrder.task_id == task.id))
    if existing:
        return _work_order_view(db, existing)

    field_keys = [
        item.field_key
        for item in db.scalars(
            select(UserFieldResponse).where(
                UserFieldResponse.task_id == task.id,
                UserFieldResponse.user_id == user.id,
            )
        )
        if not any(word in item.field_key.casefold() for word in SECRET_WORDS)
    ]
    document_ids = list(
        db.scalars(
            select(ServiceDocumentAsset.id).where(
                ServiceDocumentAsset.task_id == task.id,
                ServiceDocumentAsset.user_id == user.id,
            )
        )
    )
    handoff = create_handoff(
        db,
        task,
        approved_field_keys=field_keys,
        approved_document_ids=document_ids,
        purpose=payload.purpose,
        expected_version=task.version,
        request_id=f"seva-handoff-{task.id}-{int(datetime.utcnow().timestamp())}",
    )
    service = db.get(ServiceDefinition, task.service_id)
    service_policy = dict(service.support_contact or {}) if service else {}
    sla_days = max(1, min(int(service_policy.get("internal_sla_days") or 7), 90))
    quality_required = bool(service_policy.get("quality_required", service_policy.get("quality_review_required", False)))
    work_order = SevaWorkOrder(
        case_number=f"SEVA-{datetime.utcnow().year}-{str(uuid.uuid4()).replace('-', '')[:8].upper()}",
        task_id=task.id,
        user_id=user.id,
        handoff_id=handoff.id,
        status="QUEUED",
        department=str(service_policy.get("department") or (service.category if service else "AutoAI Seva Operations"))[:100],
        queue_name=str(service_policy.get("queue") or (service.category if service else "General"))[:100],
        request_summary=task.original_request,
        current_activity="Submitted for agent assistance",
        progress_percent=5,
        submitted_at=datetime.utcnow(),
        due_at=datetime.utcnow() + timedelta(days=sla_days),
        quality_required=quality_required,
        quality_status="REQUIRED" if quality_required else "NOT_REQUIRED",
        user_consent_scope={
            "field_keys": field_keys,
            "document_ids": document_ids,
            "authentication_secrets_shared": False,
            "approved_at": datetime.utcnow().isoformat(),
        },
    )
    db.add(work_order)
    db.flush()
    case_event(db, work_order, "CASE_SUBMITTED", "Request submitted", actor_id=user.id, dedupe_key=f"case-submitted:{work_order.id}")
    assigned = assign_best_available_agent(db, work_order)
    append_audit_event(
        db,
        task,
        "SEVA_WORK_ORDER_CREATED",
        {"work_order_id": work_order.id, "employee_assigned": bool(assigned), "authentication_shared": False},
        f"seva-work-order-{work_order.id}",
    )
    db.commit()
    db.refresh(work_order)
    return _work_order_view(db, work_order)


@router.get("/tasks/{task_id}/assistance")
def get_employee_assistance(
    task_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_owned_task(db, user.id, task_id)
    work_order = db.scalar(
        select(SevaWorkOrder).where(
            SevaWorkOrder.task_id == task_id,
            SevaWorkOrder.user_id == user.id,
        )
    )
    return {"work_order": _work_order_view(db, work_order) if work_order else None}


@router.post("/tasks/{task_id}/assistance/requirements/{requirement_id}/text")
def respond_with_text(
    task_id: str,
    requirement_id: str,
    payload: RequirementTextResponse,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_owned_task(db, user.id, task_id)
    work_order = _owned_work_order(db, user.id, task_id)
    requirement = _response_requirement(db, work_order, requirement_id)
    if requirement.kind != "TEXT" or requirement.protected_action:
        raise HTTPException(status_code=422, detail="This requirement cannot accept text")
    requirement.response_text = payload.value
    requirement.user_note = "Completed by the user on the official portal"
    requirement.status = "FULFILLED"
    requirement.responded_at = datetime.utcnow()
    work_order.status = "IN_PROGRESS"
    work_order.current_activity = f"User responded: {requirement.label}"
    work_order.progress_percent = max(work_order.progress_percent, 55)
    case_event(db, work_order, "USER_RESPONDED", "User provided requested information", actor_id=user.id, details={"requirement_id": requirement.id})
    if work_order.assigned_employee_id:
        notify(db, work_order, work_order.assigned_employee_id, "REQUIREMENT_READY", "User response received", f"{requirement.label} is ready for review.")
    db.commit()
    return _work_order_view(db, work_order)


@router.post("/tasks/{task_id}/assistance/requirements/{requirement_id}/document")
async def respond_with_document(
    task_id: str,
    requirement_id: str,
    file: UploadFile = File(...),
    note: str = Form(default=""),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, task_id)
    work_order = _owned_work_order(db, user.id, task_id)
    requirement = _response_requirement(db, work_order, requirement_id)
    if requirement.kind != "DOCUMENT" or requirement.protected_action:
        raise HTTPException(status_code=422, detail="This requirement cannot accept a document")
    inspected = await inspect_and_store_upload(
        file,
        user.id,
        accepted=["application/pdf", "image/jpeg", "image/png"],
        max_bytes=10 * 1024 * 1024,
    )
    document = Document(
        user_id=user.id,
        chat_id=task.chat_id,
        filename=inspected.filename,
        content_type=inspected.content_type,
        file_size=inspected.size,
        file_path=inspected.path,
        extracted_text="",
        summary=None,
        document_metadata={
            "private": True,
            "seva_work_order_id": work_order.id,
            "seva_requirement_id": requirement.id,
            "sha256": inspected.sha256,
            "scanner": inspected.scanner_result,
        },
    )
    db.add(document)
    db.flush()
    requirement.response_document_id = document.id
    requirement.user_note = note[:500] or None
    requirement.status = "FULFILLED"
    requirement.responded_at = datetime.utcnow()
    work_order.status = "IN_PROGRESS"
    work_order.current_activity = f"Document received: {requirement.label}"
    work_order.progress_percent = max(work_order.progress_percent, 55)
    case_event(db, work_order, "DOCUMENT_UPLOADED", "User uploaded a requested document", actor_id=user.id, details={"requirement_id": requirement.id})
    if work_order.assigned_employee_id:
        notify(db, work_order, work_order.assigned_employee_id, "DOCUMENT_READY", "Document uploaded", f"{requirement.label} is ready for review.")
    db.commit()
    return _work_order_view(db, work_order)


@router.post("/tasks/{task_id}/assistance/requirements/{requirement_id}/protected-action")
def complete_protected_action(
    task_id: str,
    requirement_id: str,
    payload: ProtectedActionResponse,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    get_owned_task(db, user.id, task_id)
    work_order = _owned_work_order(db, user.id, task_id)
    requirement = _response_requirement(db, work_order, requirement_id)
    if requirement.kind != "PROTECTED_ACTION" or not requirement.protected_action:
        raise HTTPException(status_code=422, detail="This is not a protected user action")
    if not payload.completed:
        raise HTTPException(status_code=422, detail="Complete the protected step on the official portal first")
    requirement.status = "FULFILLED"
    requirement.user_note = "Completed by the user on the approved official portal"
    requirement.responded_at = datetime.utcnow()
    work_order.status = "IN_PROGRESS"
    work_order.current_activity = f"Protected action completed: {requirement.label}"
    work_order.progress_percent = max(work_order.progress_percent, 65)
    case_event(db, work_order, "PROTECTED_ACTION_COMPLETED", "Protected action completed by user", actor_id=user.id, details={"requirement_id": requirement.id})
    if work_order.assigned_employee_id:
        notify(db, work_order, work_order.assigned_employee_id, "PROTECTED_ACTION_READY", "Protected step completed", f"The user completed: {requirement.label}.")
    db.commit()
    return _work_order_view(db, work_order)


@router.post("/tasks/{task_id}/assistance/cancel")
def cancel_employee_assistance(
    task_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, task_id)
    work_order = _owned_work_order(db, user.id, task_id)
    if work_order.status == "COMPLETED":
        raise HTTPException(status_code=409, detail="Completed assistance cannot be cancelled")
    work_order.status = "CANCELLED"
    work_order.current_activity = "Cancelled by user"
    work_order.progress_percent = 0
    work_order.cancelled_at = datetime.utcnow()
    _close_current_assignment(db, work_order, "Cancelled by user")
    handoff = db.get(HumanHandoff, work_order.handoff_id)
    if handoff:
        handoff.status = "REVOKED"
        handoff.revoked_at = datetime.utcnow()
    case_event(db, work_order, "CASE_CANCELLED", "Assistance cancelled", actor_id=user.id, dedupe_key=f"cancelled:{work_order.id}")
    assign_waiting_work(db)
    append_audit_event(
        db,
        task,
        "SEVA_WORK_ORDER_CANCELLED",
        {"work_order_id": work_order.id, "handoff_revoked": True},
        f"seva-cancel-{work_order.id}",
    )
    db.commit()
    return _work_order_view(db, work_order)


@router.get("/deliverables/{deliverable_id}/content")
def download_deliverable(
    deliverable_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    deliverable = db.get(SevaDeliverable, deliverable_id)
    if not deliverable or (deliverable.user_id != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="Deliverable not found")
    document = db.get(Document, deliverable.document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Deliverable file not found")
    path = Path(document.file_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="Deliverable file is no longer available")
    return FileResponse(path, media_type=document.content_type, filename=document.filename)


@router.get("/admin/work-orders")
def list_employee_work_orders(
    state: str | None = Query(default=None, max_length=32),
    priority: str | None = Query(default=None, max_length=16),
    sla: str | None = Query(default=None, max_length=24),
    department: str | None = Query(default=None, max_length=100),
    queue: str | None = Query(default=None, max_length=100),
    category: str | None = Query(default=None, max_length=80),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    q: str | None = Query(default=None, max_length=120),
    agent_id: str | None = Query(default=None, max_length=36),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    query = select(SevaWorkOrder)
    if not employee.is_admin:
        query = query.where(SevaWorkOrder.assigned_employee_id == employee.id)
    if state:
        query = query.where(SevaWorkOrder.status == state.upper())
    if priority:
        query = query.where(SevaWorkOrder.priority == priority.upper())
    if sla:
        query = query.where(SevaWorkOrder.sla_status == sla.upper())
    if department:
        query = query.where(SevaWorkOrder.department.ilike(f"%{department.strip()}%"))
    if queue:
        query = query.where(SevaWorkOrder.queue_name.ilike(f"%{queue.strip()}%"))
    if category:
        query = query.join(ServiceTask, ServiceTask.id == SevaWorkOrder.task_id).join(
            ServiceDefinition, ServiceDefinition.id == ServiceTask.service_id
        ).where(ServiceDefinition.category == category)
    if date_from:
        query = query.where(SevaWorkOrder.created_at >= date_from)
    if date_to:
        query = query.where(SevaWorkOrder.created_at <= date_to)
    if agent_id and employee.is_admin:
        query = query.where(SevaWorkOrder.assigned_employee_id == agent_id)
    if q:
        pattern = f"%{q.strip()}%"
        query = query.join(User, User.id == SevaWorkOrder.user_id).where(
            SevaWorkOrder.case_number.ilike(pattern) | SevaWorkOrder.request_summary.ilike(pattern) |
            User.email.ilike(pattern) | User.name.ilike(pattern)
        )
    total = int(db.scalar(select(func.count()).select_from(query.subquery())) or 0)
    items = list(db.scalars(query.order_by(SevaWorkOrder.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)))
    return {"items": [_work_order_view(db, item, include_owner=True) for item in items], "total": total, "page": page, "page_size": page_size, "has_more": page * page_size < total}


@router.get("/admin/work-orders/{work_order_id}")
def get_employee_work_order(
    work_order_id: str,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    if not employee.is_admin:
        _require_assigned_employee(work_order, employee)
        case_event(db, work_order, "CASE_OPENED", "Assigned agent opened the case", actor_id=employee.id, visibility="INTERNAL", dedupe_key=f"case-opened:{work_order.id}:{employee.id}")
        db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/reassign")
def reassign_work_order(work_order_id: str, payload: ReassignRequest, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    work_order = db.scalar(select(SevaWorkOrder).where(SevaWorkOrder.id == work_order_id).with_for_update())
    if not work_order:
        raise HTTPException(status_code=404, detail="Seva work order not found")
    if work_order.status in TERMINAL_WORK_ORDER_STATES:
        raise HTTPException(status_code=409, detail="Closed cases cannot be reassigned")
    previous_agent_id = work_order.assigned_employee_id
    _close_current_assignment(db, work_order, payload.reason)
    work_order.assigned_employee_id = None
    work_order.claimed_at = None
    work_order.status = "QUEUED"
    work_order.current_activity = "Queued for reassignment"
    if payload.agent_profile_id:
        profile = db.get(SevaAgentProfile, payload.agent_profile_id)
        if not profile or not profile.is_active or profile.status != "ACTIVE":
            raise HTTPException(status_code=422, detail="Select an active Seva agent")
        active_load = int(db.scalar(select(func.count()).select_from(SevaWorkOrder).where(
            SevaWorkOrder.assigned_employee_id == profile.user_id, SevaWorkOrder.status.in_(ACTIVE_STATES)
        )) or 0)
        if active_load >= profile.capacity:
            raise HTTPException(status_code=409, detail="Selected agent is at capacity")
        work_order.assigned_employee_id = profile.user_id
        work_order.status = "IN_PROGRESS"
        work_order.claimed_at = datetime.utcnow()
        work_order.current_activity = "Reassigned to a Seva agent"
        db.add(SevaAssignment(work_order_id=work_order.id, agent_user_id=profile.user_id, assigned_by_user_id=admin.id, reason=payload.reason))
        notify(db, work_order, profile.user_id, "CASE_REASSIGNED", "Case assigned to you", work_order.request_summary, dedupe_key=f"reassign-agent:{work_order.id}:{profile.user_id}:{datetime.utcnow().isoformat()}")
    case_event(db, work_order, "CASE_REASSIGNED", "Case reassigned" if payload.agent_profile_id else "Case unassigned", actor_id=admin.id, visibility="INTERNAL", details={"previous_agent_id": previous_agent_id, "new_agent_id": work_order.assigned_employee_id, "reason": payload.reason})
    notify(db, work_order, work_order.user_id, "CASE_REASSIGNED", "Agent assignment updated", "Your application remains active and its complete history is preserved.", dedupe_key=f"reassign-user:{work_order.id}:{datetime.utcnow().isoformat()}")
    db.add(AuditLog(actor_user_id=admin.id, target_user_id=work_order.user_id, action="seva.case.reassigned", reason=payload.reason, audit_metadata={"work_order_id": work_order.id, "case_number": work_order.case_number, "previous_agent_id": previous_agent_id, "new_agent_id": work_order.assigned_employee_id}))
    if not payload.agent_profile_id:
        assign_waiting_work(db)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.get("/agent/dashboard")
def agent_dashboard(employee: User = Depends(get_current_seva_employee), db: Session = Depends(get_db)):
    profile = _agent_profile(db, employee)
    rows = list(db.scalars(select(SevaWorkOrder).where(SevaWorkOrder.assigned_employee_id == employee.id).order_by(SevaWorkOrder.updated_at.desc()).limit(100)))
    today = datetime.utcnow().date()
    counts = {state: sum(item.status == state for item in rows) for state in ("QUEUED", "IN_PROGRESS", "WAITING_USER", "SUBMITTED", "COMPLETED")}
    return {
        "agent": _agent_view(db, profile),
        "counts": counts,
        "active_workload": sum(item.status in ACTIVE_STATES for item in rows),
        "completed_today": sum(item.completed_at is not None and item.completed_at.date() == today for item in rows),
        "attention_required": sum(bool(item.due_at and item.due_at < datetime.utcnow() and item.status not in TERMINAL_WORK_ORDER_STATES) for item in rows),
        "recent_cases": [_work_order_view(db, item, include_owner=True) for item in rows[:10]],
    }


@router.post("/admin/work-orders/{work_order_id}/claim")
def claim_employee_work_order(
    work_order_id: str,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    if work_order.status in TERMINAL_WORK_ORDER_STATES:
        raise HTTPException(status_code=409, detail="This work order is already closed")
    work_order.assigned_employee_id = employee.id
    work_order.status = "IN_PROGRESS"
    work_order.current_activity = "Agent started work"
    work_order.progress_percent = max(work_order.progress_percent, 30)
    work_order.claimed_at = work_order.claimed_at or datetime.utcnow()
    if not db.scalar(select(SevaAssignment.id).where(SevaAssignment.work_order_id == work_order.id, SevaAssignment.ended_at.is_(None))):
        db.add(SevaAssignment(work_order_id=work_order.id, agent_user_id=employee.id, assigned_by_user_id=employee.id, reason="Manual claim"))
    handoff = db.get(HumanHandoff, work_order.handoff_id)
    if handoff:
        handoff.status = "ACTIVE"
        handoff.agent_identity = {
            "id": employee.id,
            "name": employee.name,
            "role": "AutoAI Seva employee",
            "status": "ASSIGNED",
            "verified": True,
        }
    case_event(db, work_order, "WORK_STARTED", "Agent started work", actor_id=employee.id, dedupe_key=f"work-started:{work_order.id}:{employee.id}")
    notify(db, work_order, work_order.user_id, "WORK_STARTED", "Work started", "Your assigned Seva agent has started processing the application.", dedupe_key=f"work-started-user:{work_order.id}")
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/requirements", status_code=status.HTTP_201_CREATED)
def create_employee_requirement(
    work_order_id: str,
    payload: RequirementCreateRequest,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    if work_order.assigned_employee_id is None:
        work_order.assigned_employee_id = employee.id
        work_order.claimed_at = datetime.utcnow()
    if work_order.status in TERMINAL_WORK_ORDER_STATES:
        raise HTTPException(status_code=409, detail="This work order is closed")
    secret_related = any(
        word in f"{payload.label} {payload.instructions} {payload.field_key or ''}".casefold()
        for word in SECRET_WORDS
    )
    if secret_related and payload.kind != "PROTECTED_ACTION":
        raise HTTPException(
            status_code=422,
            detail="OTP, password, CAPTCHA and other secrets must be requested as a protected user action",
        )
    requirement = SevaRequirementRequest(
        work_order_id=work_order.id,
        task_id=work_order.task_id,
        user_id=work_order.user_id,
        employee_id=employee.id,
        kind=payload.kind,
        field_key=payload.field_key,
        label=payload.label,
        instructions=payload.instructions,
        required=payload.required,
        protected_action=payload.kind == "PROTECTED_ACTION",
        status="REQUESTED",
    )
    db.add(requirement)
    work_order.status = "WAITING_USER"
    work_order.current_activity = f"Waiting for user: {payload.label}"
    work_order.progress_percent = max(work_order.progress_percent, 50)
    case_event(db, work_order, "REQUIREMENT_REQUESTED", "Agent requested information", actor_id=employee.id, details={"requirement_id": requirement.id, "kind": payload.kind})
    notify(db, work_order, work_order.user_id, "REQUIREMENT_REQUESTED", "Action needed for your application", payload.label)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/requirements/{requirement_id}/review")
def review_employee_requirement(
    work_order_id: str,
    requirement_id: str,
    payload: RequirementReviewRequest,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    requirement = _response_requirement(db, work_order, requirement_id)
    if requirement.status != "FULFILLED":
        raise HTTPException(status_code=409, detail="The user has not fulfilled this requirement")
    requirement.status = "ACCEPTED" if payload.accepted else "REJECTED"
    requirement.reviewed_at = datetime.utcnow()
    if payload.accepted:
        work_order.status = "IN_PROGRESS"
        work_order.current_activity = f"Requirement accepted: {requirement.label}"
        work_order.progress_percent = max(work_order.progress_percent, 65)
        case_event(db, work_order, "REQUIREMENT_ACCEPTED", "User response accepted", actor_id=employee.id, details={"requirement_id": requirement.id})
        notify(db, work_order, work_order.user_id, "REQUIREMENT_ACCEPTED", "Response accepted", f"Your response for {requirement.label} was accepted.")
    else:
        correction = SevaRequirementRequest(
            work_order_id=work_order.id, task_id=work_order.task_id, user_id=work_order.user_id,
            employee_id=employee.id, kind=requirement.kind, field_key=requirement.field_key,
            label=requirement.label, instructions=payload.note or "Please provide a corrected response.",
            required=requirement.required, protected_action=requirement.protected_action, status="REQUESTED",
        )
        db.add(correction)
        work_order.status = "WAITING_USER"
        work_order.current_activity = f"Correction requested: {requirement.label}"
        case_event(db, work_order, "CORRECTION_REQUESTED", "Agent requested a correction", actor_id=employee.id, details={"previous_requirement_id": requirement.id})
        notify(db, work_order, work_order.user_id, "CORRECTION_REQUESTED", "Correction needed", payload.note or requirement.label)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.get("/admin/work-orders/{work_order_id}/requirements/{requirement_id}/document/content")
def download_requirement_document(
    work_order_id: str,
    requirement_id: str,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    requirement = _response_requirement(db, work_order, requirement_id)
    if requirement.kind != "DOCUMENT" or not requirement.response_document_id:
        raise HTTPException(status_code=404, detail="Requirement document not found")
    document = db.get(Document, requirement.response_document_id)
    if not document or document.user_id != work_order.user_id:
        raise HTTPException(status_code=404, detail="Requirement document not found")
    path = Path(document.file_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="Requirement document is no longer available")
    case_event(db, work_order, "REQUIREMENT_DOCUMENT_ACCESSED", "Requirement document opened by assigned agent", actor_id=employee.id, visibility="INTERNAL", details={"requirement_id": requirement.id})
    db.commit()
    return FileResponse(path, media_type=document.content_type, filename=document.filename)


@router.post("/admin/work-orders/{work_order_id}/quality-review", status_code=status.HTTP_201_CREATED)
def request_quality_review(
    work_order_id: str,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    if work_order.status in TERMINAL_WORK_ORDER_STATES:
        raise HTTPException(status_code=409, detail="Closed cases cannot enter quality review")
    unresolved = int(db.scalar(select(func.count()).select_from(SevaRequirementRequest).where(
        SevaRequirementRequest.work_order_id == work_order.id,
        SevaRequirementRequest.required.is_(True),
        SevaRequirementRequest.status != "ACCEPTED",
    )) or 0)
    if unresolved:
        raise HTTPException(status_code=409, detail="Resolve all required user responses before quality review")
    existing = db.scalar(select(SevaQualityReview).where(
        SevaQualityReview.work_order_id == work_order.id,
        SevaQualityReview.status == "PENDING",
    ))
    if existing:
        return _work_order_view(db, work_order, include_owner=True)
    task = db.get(ServiceTask, work_order.task_id)
    review = SevaQualityReview(
        work_order_id=work_order.id,
        requested_by_user_id=employee.id,
        snapshot_version=task.version if task else 1,
    )
    db.add(review)
    work_order.quality_required = True
    work_order.quality_status = "PENDING"
    work_order.status = "QUALITY_REVIEW"
    work_order.current_activity = "Waiting for quality review"
    work_order.progress_percent = max(work_order.progress_percent, 72)
    case_event(db, work_order, "QUALITY_REVIEW_REQUESTED", "Quality review requested", actor_id=employee.id, visibility="INTERNAL")
    for admin in db.scalars(select(User).where(User.is_admin.is_(True), User.is_active.is_(True))):
        notify(db, work_order, admin.id, "QUALITY_REVIEW_REQUESTED", "Case ready for quality review", work_order.case_number or work_order.id)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/quality-review/decision")
def decide_quality_review(
    work_order_id: str,
    payload: QualityReviewRequest,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    review = db.scalar(select(SevaQualityReview).where(
        SevaQualityReview.work_order_id == work_order.id,
        SevaQualityReview.status == "PENDING",
    ).order_by(SevaQualityReview.requested_at.desc()))
    if not review:
        raise HTTPException(status_code=409, detail="No pending quality review exists")
    review.reviewer_user_id = admin.id
    review.reviewed_at = datetime.utcnow()
    review.decision_reason = (payload.reason or "").strip() or None
    work_order.reviewer_user_id = admin.id
    if payload.approved:
        review.status = "APPROVED"
        work_order.quality_status = "APPROVED"
        work_order.status = "READY_TO_SUBMIT"
        work_order.current_activity = "Quality review approved — ready to submit"
        work_order.progress_percent = max(work_order.progress_percent, 80)
        title = "Quality review approved"
    else:
        review.status = "RETURNED"
        work_order.quality_status = "RETURNED"
        work_order.status = "IN_PROGRESS"
        work_order.current_activity = "Returned for correction"
        title = "Quality review returned for correction"
    case_event(db, work_order, "QUALITY_REVIEW_DECIDED", title, actor_id=admin.id, visibility="INTERNAL", details={"approved": payload.approved, "reason": review.decision_reason})
    if work_order.assigned_employee_id:
        notify(db, work_order, work_order.assigned_employee_id, "QUALITY_REVIEW_DECIDED", title, review.decision_reason or title)
    notify(db, work_order, work_order.user_id, "STATUS_UPDATED", "Application review updated", work_order.current_activity)
    db.add(AuditLog(actor_user_id=admin.id, target_user_id=work_order.user_id, action="seva.quality_review.decided", reason=review.decision_reason or title, audit_metadata={"work_order_id": work_order.id, "approved": payload.approved, "review_id": review.id}))
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/escalate")
def escalate_work_order(
    work_order_id: str,
    payload: EscalationRequest,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    if not employee.is_admin:
        _require_assigned_employee(work_order, employee)
    if work_order.status in TERMINAL_WORK_ORDER_STATES:
        raise HTTPException(status_code=409, detail="Closed cases cannot be escalated")
    work_order.status = "ESCALATED"
    work_order.sla_status = "ESCALATED"
    work_order.escalation_reason = payload.reason
    work_order.escalated_at = datetime.utcnow()
    work_order.current_activity = "Escalated for supervisor attention"
    case_event(db, work_order, "CASE_ESCALATED", "Case escalated", actor_id=employee.id, visibility="INTERNAL", details={"reason": payload.reason})
    notify(db, work_order, work_order.user_id, "CASE_ESCALATED", "Application needs supervisor attention", "The case remains active and its history is preserved.")
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.get("/admin/overview")
def seva_operations_overview(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    del admin
    rows = list(db.scalars(select(SevaWorkOrder)))
    now = datetime.utcnow()
    counts = {state: sum(item.status == state for item in rows) for state in sorted({item.status for item in rows})}
    overdue = sum(bool(item.due_at and item.due_at < now and item.status not in TERMINAL_WORK_ORDER_STATES) for item in rows)
    agents = list(db.scalars(select(SevaAgentProfile)))
    agent_views = [_agent_view(db, item) for item in agents]
    return {
        "total": len(rows),
        "counts": counts,
        "overdue": overdue,
        "pending_quality_review": sum(item.quality_status == "PENDING" for item in rows),
        "protected_actions": int(db.scalar(select(func.count()).select_from(SevaRequirementRequest).where(
            SevaRequirementRequest.protected_action.is_(True),
            SevaRequirementRequest.status == "REQUESTED",
        )) or 0),
        "agents_available": sum(item["is_active"] and item["available_slots"] > 0 for item in agent_views),
        "agents_at_capacity": sum(item["available_slots"] == 0 for item in agent_views),
    }


@router.post("/admin/work-orders/{work_order_id}/status")
def update_employee_work_order_status(
    work_order_id: str,
    payload: WorkOrderStatusRequest,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    if work_order.assigned_employee_id is None:
        work_order.assigned_employee_id = employee.id
        work_order.claimed_at = datetime.utcnow()
    if payload.status == "COMPLETED":
        raise HTTPException(status_code=422, detail="Upload a verified receipt or deliverable to complete this case")
    if payload.status != work_order.status and payload.status not in ALLOWED_WORK_ORDER_TRANSITIONS.get(work_order.status, set()):
        raise HTTPException(status_code=409, detail=f"Cannot change case from {work_order.status} to {payload.status}")
    if payload.status in {"READY_TO_SUBMIT", "SUBMITTED", "SUBMITTED_TO_AUTHORITY"} and work_order.quality_required and work_order.quality_status != "APPROVED":
        raise HTTPException(status_code=409, detail="Required quality review must be approved before submission")
    if payload.progress_percent is not None:
        if payload.progress_percent < work_order.progress_percent:
            raise HTTPException(status_code=422, detail="Progress cannot move backwards")
        if payload.status != "SUBMITTED" and payload.progress_percent >= 100:
            raise HTTPException(status_code=422, detail="Only a completed case can reach 100%")
        work_order.progress_percent = payload.progress_percent
    if payload.status in {"SUBMITTED", "SUBMITTED_TO_AUTHORITY"}:
        reference = (payload.reference_number or work_order.reference_number or "").strip()
        if not reference:
            raise HTTPException(status_code=422, detail="Reference number is required when marking submitted")
        work_order.reference_number = reference
        work_order.submitted_at = datetime.utcnow()
        work_order.progress_percent = max(work_order.progress_percent, 90)
        work_order.official_status = "Submitted to authority" if payload.status == "SUBMITTED_TO_AUTHORITY" else "Submitted"
    elif payload.status == "UNDER_AUTHORITY_PROCESSING":
        work_order.official_status = "Under authority processing"
    elif payload.status in {"APPROVED", "REJECTED", "ISSUED", "DELIVERED"}:
        work_order.official_status = payload.status.replace("_", " ").title()
    work_order.status = payload.status
    work_order.employee_note = payload.note
    work_order.current_activity = payload.note or payload.status.replace("_", " ").title()
    if payload.status == "CANCELLED":
        work_order.cancelled_at = datetime.utcnow()
        work_order.progress_percent = 0
        _close_current_assignment(db, work_order, "Cancelled by agent")
    elif payload.status in {"DELIVERED", "REJECTED"}:
        work_order.completed_at = datetime.utcnow()
        work_order.progress_percent = 100
        _close_current_assignment(db, work_order, f"Case {payload.status.lower()}")
    case_event(db, work_order, "STATUS_UPDATED", f"Status changed to {payload.status.replace('_', ' ').title()}", actor_id=employee.id, details={"progress": work_order.progress_percent, "reference_number_present": bool(work_order.reference_number)})
    notify(db, work_order, work_order.user_id, "STATUS_UPDATED", "Application status updated", f"Status: {payload.status.replace('_', ' ').title()}. {payload.note or ''}".strip())
    if payload.status in TERMINAL_WORK_ORDER_STATES:
        assign_waiting_work(db)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)


@router.post("/admin/work-orders/{work_order_id}/deliverables", status_code=status.HTTP_201_CREATED)
async def upload_employee_deliverable(
    work_order_id: str,
    label: str = Form(default="Application receipt"),
    note: str = Form(default=""),
    mark_completed: bool = Form(default=True),
    file: UploadFile = File(...),
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    if mark_completed:
        unresolved = int(db.scalar(select(func.count()).select_from(SevaRequirementRequest).where(
            SevaRequirementRequest.work_order_id == work_order.id,
            SevaRequirementRequest.required.is_(True),
            SevaRequirementRequest.status != "ACCEPTED",
        )) or 0)
        if unresolved:
            raise HTTPException(status_code=409, detail="Accept every required user response before completing the case")
    if work_order.assigned_employee_id is None:
        work_order.assigned_employee_id = employee.id
        work_order.claimed_at = datetime.utcnow()
    task = db.get(ServiceTask, work_order.task_id)
    inspected = await inspect_and_store_upload(
        file,
        work_order.user_id,
        accepted=["application/pdf", "image/jpeg", "image/png"],
        max_bytes=10 * 1024 * 1024,
    )
    document = Document(
        user_id=work_order.user_id,
        chat_id=task.chat_id if task else None,
        filename=inspected.filename,
        content_type=inspected.content_type,
        file_size=inspected.size,
        file_path=inspected.path,
        extracted_text="",
        summary=None,
        document_metadata={
            "private": True,
            "seva_work_order_id": work_order.id,
            "employee_deliverable": True,
            "uploaded_by_employee_id": employee.id,
            "sha256": inspected.sha256,
            "scanner": inspected.scanner_result,
        },
    )
    db.add(document)
    db.flush()
    deliverable = SevaDeliverable(
        work_order_id=work_order.id,
        task_id=work_order.task_id,
        user_id=work_order.user_id,
        employee_id=employee.id,
        document_id=document.id,
        kind="APPLICATION_RECEIPT",
        label=label[:180] or "Application receipt",
        note=note[:2000] or None,
        verified_by_employee=True,
    )
    db.add(deliverable)
    db.flush()
    if mark_completed:
        work_order.status = "COMPLETED"
        work_order.completed_at = datetime.utcnow()
        work_order.progress_percent = 100
        work_order.current_activity = "Completed — receipt available"
        _close_current_assignment(db, work_order, "Case completed")
    else:
        work_order.status = "SUBMITTED"
        work_order.progress_percent = max(work_order.progress_percent, 90)
        work_order.current_activity = "Submitted — receipt uploaded"
    case_event(db, work_order, "CASE_COMPLETED" if mark_completed else "RECEIPT_UPLOADED", "Case completed" if mark_completed else "Application receipt uploaded", actor_id=employee.id, details={"deliverable_id": deliverable.id})
    notify(db, work_order, work_order.user_id, "DELIVERABLE_READY", "Application receipt ready", deliverable.label)
    if mark_completed:
        assign_waiting_work(db)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)
