from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

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
from app.models.autoai_seva import SevaAgentProfile, SevaDeliverable, SevaNotification, SevaRequirementRequest, SevaWorkOrder
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
from app.services.form_service_registry import RegistryResolution, ensure_service_registry, resolve_service
from app.services.form_service_service import (
    build_task_view,
    create_handoff,
    create_task,
    get_owned_task,
    service_error,
    start_task,
)
from app.services.form_service_state import append_audit_event
from app.services.seva_assignment import ACTIVE_STATES, assign_best_available_agent, assign_waiting_work, notify, queue_position


router = APIRouter(prefix="/seva-operations", tags=["autoai-seva-operations"])

SECRET_WORDS = (
    "password", "passcode", "otp", "pin", "captcha", "cvv", "secret", "token",
    "recovery code", "credential", "authentication code", "verification code", "one-time code",
    "पासवर्ड", "ओटीपी", "पिन", "कैप्चा", "सीवीवी",
)
TERMINAL_WORK_ORDER_STATES = {"COMPLETED", "CANCELLED"}


class SevaStartRequest(BaseModel):
    query: str = Field(min_length=3, max_length=1000)
    timezone: str = Field(default="Asia/Kolkata", max_length=100)
    locale: str = Field(default="hi-IN", max_length=35)
    client_request_id: str = Field(min_length=8, max_length=120)


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
    status: Literal["QUEUED", "IN_PROGRESS", "WAITING_USER", "SUBMITTED", "COMPLETED", "CANCELLED"]
    note: str | None = Field(default=None, max_length=2000)


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


class AgentUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    password: str | None = Field(default=None, min_length=8, max_length=128)
    capacity: int | None = Field(default=None, ge=1, le=50)
    is_active: bool | None = None


def _agent_profile(db: Session, user: User) -> SevaAgentProfile | None:
    return db.scalar(select(SevaAgentProfile).where(SevaAgentProfile.user_id == user.id))


def get_current_seva_employee(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    if user.is_admin and user.role in {"admin", "super_admin", "administrator"}:
        return user
    profile = _agent_profile(db, user)
    if not profile or not profile.is_active or user.role != "seva_agent":
        raise HTTPException(status_code=403, detail="Active Seva agent access required")
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
        "capacity": profile.capacity,
        "active_load": active_load,
        "available_slots": max(0, profile.capacity - active_load) if profile.is_active else 0,
        "is_active": profile.is_active,
        "last_assigned_at": profile.last_assigned_at,
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
    owner_email_approved = any("email" in str(key).casefold() for key in (work_order.user_consent_scope or {}).get("field_keys", []))
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
    progress_by_status = {"QUEUED": 5, "IN_PROGRESS": 35, "WAITING_USER": 50, "SUBMITTED": 90, "COMPLETED": 100, "CANCELLED": 0}
    work_progress = progress_by_status.get(work_order.status, 10)
    if work_order.status == "IN_PROGRESS" and requirements:
        work_progress = min(85, 35 + round(fulfilled / len(requirements) * 45))
    return {
        "id": work_order.id,
        "task_id": work_order.task_id,
        "handoff_id": work_order.handoff_id,
        "status": work_order.status,
        "priority": work_order.priority,
        "request_summary": work_order.request_summary,
        "employee_note": work_order.employee_note,
        "assigned_employee": ({"id": employee.id, "name": employee.name} if employee else None),
        "owner": ({"id": owner.id, "name": owner.name, "email": owner.email if owner_email_approved else None} if owner else None),
        "service": ({"id": service.id, "name": service.name, "provider": service.provider} if service else None),
        "task_state": task.state if task else None,
        "task_progress": task.progress_percent if task else 0,
        "work_progress": work_progress,
        "current_activity": work_order.employee_note or work_order.status.replace("_", " ").title(),
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
    if not profile or not profile.is_active or not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Agent ID or password is incorrect")
    ensure_user_can_authenticate(user)
    return issue_session(db, user, request, response)


@router.get("/admin/agents")
def list_seva_agents(admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    del admin
    profiles = list(db.scalars(select(SevaAgentProfile).order_by(SevaAgentProfile.created_at.desc())))
    return {"items": [_agent_view(db, item) for item in profiles], "total": len(profiles)}


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
            created_by_admin_id=admin.id,
        )
        db.add(profile)
        db.flush()
        assign_waiting_work(db)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="This agent ID is already in use") from exc
    db.refresh(profile)
    return _agent_view(db, profile)


@router.patch("/admin/agents/{profile_id}")
def update_seva_agent(profile_id: str, payload: AgentUpdateRequest, admin: User = Depends(get_current_admin), db: Session = Depends(get_db)):
    del admin
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
    if payload.is_active is not None:
        profile.is_active = payload.is_active
        if user:
            user.is_active = payload.is_active
        if not payload.is_active:
            assigned = list(db.scalars(select(SevaWorkOrder).where(
                SevaWorkOrder.assigned_employee_id == profile.user_id,
                SevaWorkOrder.status.in_(ACTIVE_STATES),
            )))
            for work_order in assigned:
                work_order.assigned_employee_id = None
                work_order.status = "QUEUED"
                work_order.claimed_at = None
                handoff = db.get(HumanHandoff, work_order.handoff_id)
                if handoff:
                    handoff.status = "APPROVED"
                    handoff.agent_identity = {"status": "UNASSIGNED", "verified": False}
                notify(db, work_order, work_order.user_id, "AGENT_REASSIGNING", "Assigning another Seva agent", "Your application remains safe in the assignment queue.")
    if payload.password is not None and user:
        user.hashed_password = get_password_hash(payload.password)
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
        "title": item.title, "message": item.message, "read_at": item.read_at, "created_at": item.created_at,
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
    if work_order.assigned_employee_id not in {None, employee.id}:
        raise HTTPException(status_code=409, detail="This work order is assigned to another employee")


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
    work_order = SevaWorkOrder(
        task_id=task.id,
        user_id=user.id,
        handoff_id=handoff.id,
        status="QUEUED",
        request_summary=task.original_request,
        user_consent_scope={
            "field_keys": field_keys,
            "document_ids": document_ids,
            "authentication_secrets_shared": False,
            "approved_at": datetime.utcnow().isoformat(),
        },
    )
    db.add(work_order)
    db.flush()
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
    requirement.user_note = payload.note
    requirement.responded_at = datetime.utcnow()
    work_order.status = "IN_PROGRESS"
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
    work_order.cancelled_at = datetime.utcnow()
    handoff = db.get(HumanHandoff, work_order.handoff_id)
    if handoff:
        handoff.status = "REVOKED"
        handoff.revoked_at = datetime.utcnow()
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
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    query = select(SevaWorkOrder)
    if not employee.is_admin:
        query = query.where(SevaWorkOrder.assigned_employee_id == employee.id)
    if state:
        query = query.where(SevaWorkOrder.status == state.upper())
    items = list(db.scalars(query.order_by(SevaWorkOrder.updated_at.desc()).limit(200)))
    return {"items": [_work_order_view(db, item, include_owner=True) for item in items], "total": len(items)}


@router.get("/admin/work-orders/{work_order_id}")
def get_employee_work_order(
    work_order_id: str,
    employee: User = Depends(get_current_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _admin_work_order(db, work_order_id)
    _require_assigned_employee(work_order, employee)
    return _work_order_view(db, work_order, include_owner=True)


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
    work_order.claimed_at = work_order.claimed_at or datetime.utcnow()
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
    requirement.instructions = payload.note or requirement.instructions
    requirement.reviewed_at = datetime.utcnow()
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
    return FileResponse(path, media_type=document.content_type, filename=document.filename)


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
    work_order.status = payload.status
    work_order.employee_note = payload.note
    if payload.status == "COMPLETED":
        work_order.completed_at = datetime.utcnow()
    if payload.status == "CANCELLED":
        work_order.cancelled_at = datetime.utcnow()
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
    if mark_completed:
        work_order.status = "COMPLETED"
        work_order.completed_at = datetime.utcnow()
    else:
        work_order.status = "SUBMITTED"
    notify(db, work_order, work_order.user_id, "DELIVERABLE_READY", "Application receipt ready", deliverable.label)
    if mark_completed:
        assign_waiting_work(db)
    db.commit()
    return _work_order_view(db, work_order, include_owner=True)
