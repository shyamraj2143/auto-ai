from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.document import Document
from app.models.form_service import (
    ConsentGrant,
    DocumentRequirement,
    PortalAdapterRecord,
    ReceiptEvidence,
    ServiceActionReceipt,
    ServiceDefinition,
    ServiceSecureChallenge,
)
from app.models.user import User
from app.schemas.form_service import (
    ConfirmationRequest,
    FieldsSubmitRequest,
    PortalSessionRequest,
    SecureResponseRequest,
    ServiceTaskCreate,
    SubmissionRequest,
    TaskActionRequest,
)
from app.services.autoai_seva_conflicts import (
    conflict_view,
    get_owned_conflict,
    list_task_conflicts,
    resolve_field_conflict,
    scan_task_conflicts,
)
from app.services.autoai_seva_review import (
    FINAL_CONSENT_TYPE,
    NOTICE_VERSION,
    compute_review_hash,
    public_state,
)
from app.services.form_service_adapters import AdapterContext, adapter_for
from app.services.form_service_documents import inspect_and_store_upload
from app.services.form_service_registry import RegistryResolution, ensure_service_registry
from app.services.form_service_service import (
    approve_review,
    attach_document,
    build_task_view,
    cancel_task,
    confirm_submission,
    create_portal_session,
    create_task,
    ensure_version,
    get_owned_task,
    list_tasks,
    prepare_task,
    service_error,
    start_task,
    submit_fields,
    submit_task,
    track_task,
)
from app.services.form_service_state import append_audit_event


router = APIRouter(prefix="/service-applications", tags=["service-applications"])

_STATUS_LOCK = threading.Lock()
_STATUS_LAST_CHECK: dict[tuple[str, str], float] = {}
_STATUS_MIN_INTERVAL_SECONDS = 5.0


class TypedConsentRequest(BaseModel):
    version: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=120)
    consent_type: Literal[
        "INFORMATION_COLLECTION",
        "DOCUMENT_PROCESSING",
        "CLOUD_OCR",
        "PORTAL_ASSISTANCE",
        "FINAL_SUBMISSION",
    ]
    data_scope: list[str] = Field(default_factory=list, max_length=100)
    notice_version: str = Field(default=NOTICE_VERSION, min_length=3, max_length=80)
    expires_in_minutes: int | None = Field(default=60, ge=1, le=43200)


class ConflictResolutionRequest(BaseModel):
    selected_source: Literal["user", "document", "manual"]
    manual_value: Any | None = None
    resolution_note: str | None = Field(default=None, max_length=240)
    request_id: str = Field(min_length=8, max_length=120)


class TransientChallengeRequest(BaseModel):
    version: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=120)
    kind: Literal["otp", "captcha"]


class PrepareReviewRequest(BaseModel):
    version: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=120)
    approve_review: bool = False


def _application_payload(db: Session, task) -> dict[str, Any]:
    view = build_task_view(db, task)
    payload = view.model_dump(mode="json")
    payload["public_state"] = public_state(task.state)
    try:
        payload["review_hash"] = compute_review_hash(db, task) if task.state in {
            "REVIEW_REQUIRED",
            "SUBMISSION_CONFIRMATION_REQUIRED",
            "SUBMITTING",
        } else None
    except Exception:
        payload["review_hash"] = None
    payload["open_conflict_count"] = sum(
        item.resolution_state == "OPEN" for item in list_task_conflicts(db, task)
    )
    return payload


@router.post("", status_code=status.HTTP_201_CREATED)
def create_application(
    payload: ServiceTaskCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_service_registry(db)
    service = db.get(ServiceDefinition, payload.service_id)
    if not service or not service.active:
        raise service_error("SERVICE_NOT_FOUND", "The requested service is not active", http_status=404)
    from app.models.form_service import ServicePortal

    portal = db.scalar(
        select(ServicePortal).where(
            ServicePortal.service_id == service.id,
            ServicePortal.verified.is_(True),
        )
    )
    adapter = db.scalar(
        select(PortalAdapterRecord).where(
            PortalAdapterRecord.service_id == service.id,
            PortalAdapterRecord.enabled.is_(True),
        )
    )
    if not adapter:
        raise service_error("ADAPTER_UNAVAILABLE", "No enabled service adapter is available", http_status=503)
    task = create_task(
        db,
        user.id,
        RegistryResolution(service, portal, adapter, 1.0),
        chat_id=payload.chat_id,
        original_request=payload.original_request,
        execution_mode=payload.execution_mode,
        timezone=payload.timezone,
        locale=payload.locale,
        client_request_id=payload.client_request_id,
    )
    start_task(
        db,
        task,
        expected_version=task.version,
        request_id=f"service-application-start-{task.id}",
        actor="user",
        source="service_applications_api",
        reason="User created a dedicated AutoAI Seva application",
    )
    return _application_payload(db, task)


@router.get("")
def get_applications(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    state: str | None = Query(default=None, max_length=64),
    q: str | None = Query(default=None, max_length=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items, total = list_tasks(db, user.id, page=page, page_size=page_size, state=state, search=q)
    return {
        "items": [_application_payload(db, get_owned_task(db, user.id, item.id)) for item in items],
        "page": page,
        "page_size": page_size,
        "total": total,
        "has_more": page * page_size < total,
    }


@router.get("/{application_id}")
def get_application(
    application_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _application_payload(db, get_owned_task(db, user.id, application_id))


@router.patch("/{application_id}/fields")
def update_application_fields(
    application_id: str,
    payload: FieldsSubmitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    submit_fields(
        db,
        task,
        data_request_id=payload.data_request_id,
        values=payload.values,
        expected_version=payload.version,
        request_id=payload.request_id,
    )
    return _application_payload(db, task)


@router.post("/{application_id}/documents")
async def upload_application_document(
    application_id: str,
    requirement_id: str = Form(...),
    version: int = Form(...),
    request_id: str = Form(...),
    save_to_vault: bool = Form(False),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    requirement = db.scalar(
        select(DocumentRequirement).where(
            DocumentRequirement.id == requirement_id,
            DocumentRequirement.task_id == task.id,
            DocumentRequirement.user_id == user.id,
        )
    )
    if not requirement:
        raise service_error("DOCUMENT_REQUIRED", "Document requirement not found", http_status=404)
    inspected = await inspect_and_store_upload(
        file,
        user.id,
        accepted=requirement.accepted_mime_types,
        max_bytes=requirement.max_bytes,
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
            "form_service_task_id": task.id,
            "private": True,
            "sha256": inspected.sha256,
            "scanner": inspected.scanner_result,
            "page_count": inspected.page_count,
            "image_dimensions": inspected.dimensions,
            "embedded_text_retained": False,
            "save_to_vault_requested": save_to_vault,
        },
    )
    try:
        db.add(document)
        db.flush()
        attach_document(
            db,
            task,
            requirement=requirement,
            document=document,
            inspected=inspected,
            save_to_vault=save_to_vault,
            expected_version=version,
            request_id=request_id,
        )
    except Exception:
        db.rollback()
        Path(inspected.path).unlink(missing_ok=True)
        raise
    return _application_payload(db, task)


@router.post("/{application_id}/consents")
def grant_typed_consent(
    application_id: str,
    payload: TypedConsentRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    ensure_version(task, payload.version)
    if payload.consent_type == FINAL_CONSENT_TYPE:
        raise service_error(
            "USER_CONFIRMATION_REQUIRED",
            "Final submission consent is created only by the exact final confirmation step",
            http_status=422,
        )
    grant = ConsentGrant(
        task_id=task.id,
        user_id=user.id,
        purpose=payload.consent_type,
        data_scope=[*payload.data_scope, f"notice_version:{payload.notice_version}"],
        status="ACTIVE",
        expires_at=datetime.utcnow() + timedelta(minutes=payload.expires_in_minutes)
        if payload.expires_in_minutes
        else None,
    )
    db.add(grant)
    task.version += 1
    append_audit_event(
        db,
        task,
        "TYPED_CONSENT_GRANTED",
        {
            "grant_id": grant.id,
            "consent_type": payload.consent_type,
            "data_scope": payload.data_scope,
            "notice_version": payload.notice_version,
        },
        payload.request_id,
    )
    db.commit()
    return _application_payload(db, task)


@router.post("/{application_id}/conflicts/scan")
def scan_application_conflicts(
    application_id: str,
    request_id: str = Query(..., min_length=8, max_length=120),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    return [conflict_view(item) for item in scan_task_conflicts(db, task, request_id=request_id)]


@router.get("/{application_id}/conflicts")
def get_application_conflicts(
    application_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    return [conflict_view(item) for item in list_task_conflicts(db, task)]


@router.post("/{application_id}/conflicts/{conflict_id}/resolve")
def resolve_application_conflict(
    application_id: str,
    conflict_id: str,
    payload: ConflictResolutionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    conflict = get_owned_conflict(db, task, conflict_id)
    if not conflict:
        raise service_error("SERVICE_NOT_FOUND", "Field conflict not found", http_status=404)
    try:
        resolved = resolve_field_conflict(
            db,
            task,
            conflict,
            selected_source=payload.selected_source,
            manual_value=payload.manual_value,
            resolution_note=payload.resolution_note,
            request_id=payload.request_id,
        )
    except ValueError as exc:
        raise service_error("FIELD_VALIDATION_FAILED", str(exc), http_status=422) from exc
    return {"conflict": conflict_view(resolved), "application": _application_payload(db, task)}


@router.post("/{application_id}/prepare-review")
def prepare_application_review(
    application_id: str,
    payload: PrepareReviewRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    open_conflicts = [item for item in list_task_conflicts(db, task) if item.resolution_state == "OPEN"]
    if open_conflicts:
        raise service_error(
            "FIELD_CONFLICT_UNRESOLVED",
            "Resolve all field conflicts before preparing final review",
            http_status=422,
            recovery=["review_conflicts"],
        )
    if task.state == "READY_TO_PREPARE":
        prepare_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    elif task.state == "REVIEW_REQUIRED" and payload.approve_review:
        approve_review(db, task, expected_version=payload.version, request_id=payload.request_id)
    elif task.state not in {"REVIEW_REQUIRED", "SUBMISSION_CONFIRMATION_REQUIRED"}:
        raise service_error("POLICY_BLOCKED", "The application is not ready for review")
    return _application_payload(db, task)


@router.post("/{application_id}/confirmation")
def confirm_application_submission(
    application_id: str,
    payload: ConfirmationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    confirm_submission(
        db,
        task,
        expected_version=payload.version,
        declaration_accepted=payload.declaration_accepted,
        device_confirmation=payload.device_confirmation,
        request_id=payload.request_id,
    )
    return _application_payload(db, task)


@router.post("/{application_id}/portal-session")
def open_application_portal_session(
    application_id: str,
    payload: PortalSessionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    create_portal_session(db, task, expected_version=payload.version, request_id=payload.request_id)
    return _application_payload(db, task)


@router.post("/{application_id}/transient-challenges")
def create_transient_challenge(
    application_id: str,
    payload: TransientChallengeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    ensure_version(task, payload.version)
    service = db.get(ServiceDefinition, task.service_id)
    adapter_record = db.get(PortalAdapterRecord, task.adapter_id)
    if not service or not adapter_record:
        raise service_error("ADAPTER_UNAVAILABLE", "Service adapter is unavailable", http_status=503)
    if adapter_record.adapter_key != "autoai_seva_demo_local_verified":
        raise service_error(
            "UNSUPPORTED_OPERATION",
            "Enter OTP and CAPTCHA directly on the verified official portal",
            http_status=422,
            recovery=["open_portal"],
        )
    challenge = ServiceSecureChallenge(
        task_id=task.id,
        user_id=user.id,
        kind=payload.kind,
        official_origin="https://autoai.site.je",
        status="PENDING",
        expires_at=datetime.utcnow() + timedelta(minutes=2),
    )
    db.add(challenge)
    task.version += 1
    append_audit_event(
        db,
        task,
        "TRANSIENT_CHALLENGE_CREATED",
        {"challenge_id": challenge.id, "kind": payload.kind, "expires_in_seconds": 120},
        payload.request_id,
    )
    db.commit()
    return {
        "challenge_id": challenge.id,
        "kind": challenge.kind,
        "expires_at": challenge.expires_at,
        "persisted_secret": False,
        "application": _application_payload(db, task),
    }


@router.post("/{application_id}/transient-challenges/{challenge_id}/response")
def answer_transient_challenge(
    application_id: str,
    challenge_id: str,
    payload: SecureResponseRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    challenge = db.scalar(
        select(ServiceSecureChallenge).where(
            ServiceSecureChallenge.id == challenge_id,
            ServiceSecureChallenge.task_id == task.id,
            ServiceSecureChallenge.user_id == user.id,
        )
    )
    if not challenge:
        raise service_error("SERVICE_NOT_FOUND", "Transient challenge not found", http_status=404)
    if challenge.status != "PENDING" or challenge.expires_at <= datetime.utcnow():
        challenge.status = "EXPIRED"
        db.commit()
        raise service_error("SESSION_EXPIRED", "Transient challenge expired", http_status=410)
    service = db.get(ServiceDefinition, task.service_id)
    adapter_record = db.get(PortalAdapterRecord, task.adapter_id)
    if not service or not adapter_record:
        raise service_error("ADAPTER_UNAVAILABLE", "Service adapter is unavailable", http_status=503)
    context = AdapterContext(task, service, None, adapter_record, {}, [])
    result = adapter_for(adapter_record).consume_secret(context, challenge.kind, payload.secret)
    challenge.attempt_count += 1
    if not result.get("accepted"):
        append_audit_event(
            db,
            task,
            "TRANSIENT_RESPONSE_REJECTED",
            {"challenge_id": challenge.id, "kind": challenge.kind, "persisted_secret": False},
            payload.request_id,
        )
        db.commit()
        raise service_error("AUTHENTICATION_REQUIRED", "Transient verification was not accepted", http_status=422)
    challenge.status = "CONSUMED"
    challenge.consumed_at = datetime.utcnow()
    append_audit_event(
        db,
        task,
        "TRANSIENT_RESPONSE_CONSUMED",
        {"challenge_id": challenge.id, "kind": challenge.kind, "persisted_secret": False},
        payload.request_id,
    )
    db.commit()
    return {"accepted": True, "persisted_secret": False, "application": _application_payload(db, task)}


@router.post("/{application_id}/submit")
def submit_application(
    application_id: str,
    payload: SubmissionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    submit_task(
        db,
        task,
        confirmation_id=payload.confirmation_id,
        idempotency_key=payload.idempotency_key,
        expected_version=payload.version,
        request_id=payload.request_id,
    )
    return _application_payload(db, task)


@router.get("/{application_id}/status")
def get_application_status(
    application_id: str,
    refresh: bool = Query(False),
    request_id: str = Query(default="service-application-status", min_length=8, max_length=120),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    tracking = None
    if refresh:
        key = (user.id, task.id)
        now = time.monotonic()
        with _STATUS_LOCK:
            previous = _STATUS_LAST_CHECK.get(key, 0.0)
            if now - previous < _STATUS_MIN_INTERVAL_SECONDS:
                raise service_error(
                    "RATE_LIMITED",
                    "Status was checked recently. Wait a few seconds before refreshing.",
                    http_status=429,
                    retryable=True,
                )
            _STATUS_LAST_CHECK[key] = now
        tracking = track_task(db, task, request_id=request_id)
    return {
        "id": task.id,
        "state": task.state,
        "public_state": public_state(task.state),
        "progress_percent": task.progress_percent,
        "updated_at": task.updated_at,
        "tracking": tracking,
    }


def _receipt_payload(db: Session, user_id: str, task_id: str) -> dict[str, Any]:
    receipt = db.scalar(
        select(ServiceActionReceipt).where(
            ServiceActionReceipt.task_id == task_id,
            ServiceActionReceipt.user_id == user_id,
        )
    )
    if not receipt:
        raise service_error("SERVICE_NOT_FOUND", "Action receipt not found", http_status=404)
    evidence = list(
        db.scalars(
            select(ReceiptEvidence).where(
                ReceiptEvidence.receipt_id == receipt.id,
                ReceiptEvidence.user_id == user_id,
            )
        )
    )
    return {
        "receipt": {
            "id": receipt.id,
            "status": receipt.status,
            "application_id": receipt.application_id,
            "transaction_id": receipt.transaction_id,
            "fee": receipt.fee,
            "document_count": receipt.document_count,
            "portal_origin": receipt.portal_origin,
            "expected_timeline": receipt.expected_timeline,
            "submitted_at": receipt.submitted_at.isoformat(),
            "verified_at": receipt.verified_at.isoformat() if receipt.verified_at else None,
        },
        "evidence": [
            {
                "id": item.id,
                "evidence_type": item.evidence_type,
                "reference": item.reference,
                "checksum": item.checksum,
                "verified": item.verified,
                "created_at": item.created_at.isoformat(),
            }
            for item in evidence
        ],
    }


@router.get("/{application_id}/receipt")
def get_application_receipt(
    application_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    return _receipt_payload(db, user.id, task.id)


@router.get("/{application_id}/receipt/download")
def download_application_receipt(
    application_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    payload = _receipt_payload(db, user.id, task.id)
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    return StreamingResponse(
        BytesIO(data),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="autoai-seva-receipt-{task.id}.json"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{application_id}/cancel")
def cancel_application(
    application_id: str,
    payload: TaskActionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, application_id)
    cancel_task(
        db,
        task,
        expected_version=payload.version,
        request_id=payload.request_id,
        reason=payload.reason,
    )
    return _application_payload(db, task)
