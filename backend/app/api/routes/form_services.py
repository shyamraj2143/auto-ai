from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.document import Document
from app.models.form_service import (
    ConsentGrant,
    DocumentAnalysis,
    DocumentRequirement,
    PermissionRequest,
    PortalSession,
    ReceiptEvidence,
    ServiceActionReceipt,
    ServiceAuditEvent,
    ServiceDefinition,
    ServiceDocumentAsset,
    ServicePortal,
    ServiceSecureChallenge,
)
from app.models.library_asset import LibraryAsset
from app.models.user import User
from app.schemas.form_service import (
    AnalysisDecisionRequest,
    ConfirmationRequest,
    ConsentRequest,
    DocumentOcrRequest,
    ExecutionMode,
    FieldsSubmitRequest,
    HandoffRequest,
    HumanActionRequest,
    PermissionCreateRequest,
    PermissionResolveRequest,
    PortalOutcomeRequest,
    PortalSessionRequest,
    SecureChallengeRequest,
    SecureResponseRequest,
    ServiceIntentRequest,
    ServiceIntentResponse,
    ServiceTaskCreate,
    ServiceTaskView,
    SubmissionRequest,
    TaskActionRequest,
    TaskListResponse,
    VaultDocumentAttachRequest,
)
from app.services.form_service_documents import inspect_and_store_upload, valid_document_access_signature
from app.services.form_service_registry import ensure_service_registry, resolve_service
from app.services.form_service_service import (
    attach_document,
    analyze_document_ocr,
    approve_review,
    build_task_view,
    cancel_task,
    complete_human_action,
    confirm_submission,
    consume_secure_response,
    create_handoff,
    create_portal_session,
    create_task,
    decide_document_analysis,
    edit_task_information,
    ensure_version,
    get_owned_task,
    list_tasks,
    pause_task,
    prepare_task,
    report_portal_outcome,
    request_permission,
    request_secure_challenge,
    remove_document,
    reopen_documents,
    resolve_permission,
    resume_task,
    retry_task,
    review_again,
    revoke_consent,
    revoke_handoff,
    service_error,
    start_task,
    submit_fields,
    submit_task,
    track_task,
)
from app.services.form_service_state import append_audit_event
from app.services.form_service_tools import FORM_SERVICE_TOOLS
from app.services.library_asset_service import upsert_library_asset
from app.services.library_storage import library_storage


router = APIRouter(prefix="/form-services", tags=["form-services"])


@router.get("/tools")
def list_service_tools(user: User = Depends(get_current_user)):
    del user
    return [{"name": item.name, "risk": item.risk.value, "required_consent": item.required_consent, "required_permission": item.required_permission, "timeout_seconds": item.timeout_seconds, "max_attempts": item.max_attempts, "allowed_states": sorted(item.allowed_states)} for item in FORM_SERVICE_TOOLS.values()]


@router.post("/interpret", response_model=ServiceIntentResponse)
def interpret_service_request(payload: ServiceIntentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ensure_service_registry(db)
    resolution = resolve_service(db, payload.message)
    if not resolution:
        return ServiceIntentResponse(handled=False, confidence=0, reason="No verified service matched this message", chat_id=payload.chat_id)
    mode = ExecutionMode.EXECUTE_WITH_CONFIRMATION if resolution.adapter.adapter_type == "local_verified" else ExecutionMode.ASSIST
    task = create_task(db, user.id, resolution, chat_id=payload.chat_id, original_request=payload.message, execution_mode=mode, timezone=payload.timezone, locale=payload.locale, client_request_id=payload.client_request_id)
    return ServiceIntentResponse(handled=True, confidence=resolution.confidence, reason="Matched against the persisted verified service registry", chat_id=task.chat_id, task=build_task_view(db, task))


@router.get("/registry")
def list_registry(q: str | None = Query(default=None, max_length=100), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    del user
    ensure_service_registry(db)
    query = select(ServiceDefinition).where(ServiceDefinition.active.is_(True))
    if q:
        query = query.where(ServiceDefinition.name.ilike(f"%{q.strip()}%"))
    services = list(db.scalars(query.order_by(ServiceDefinition.name).limit(100)))
    response = []
    for item in services:
        portal = db.scalar(select(ServicePortal).where(ServicePortal.service_id == item.id, ServicePortal.verified.is_(True)))
        response.append({"id": item.id, "name": item.name, "provider": item.provider, "category": item.category, "verified": item.verified, "execution_modes": item.execution_modes, "official_origin": portal.origin if portal else None, "last_verified_at": item.last_verified_at})
    return response


@router.post("/tasks", response_model=ServiceTaskView, status_code=status.HTTP_201_CREATED)
def create_service_task(payload: ServiceTaskCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ensure_service_registry(db)
    service = db.get(ServiceDefinition, payload.service_id)
    if not service or not service.active:
        raise service_error("SERVICE_NOT_FOUND", "The requested service is not in the active registry", http_status=404)
    portal = db.scalar(select(ServicePortal).where(ServicePortal.service_id == service.id, ServicePortal.verified.is_(True)))
    from app.models.form_service import PortalAdapterRecord
    adapter = db.scalar(select(PortalAdapterRecord).where(PortalAdapterRecord.service_id == service.id, PortalAdapterRecord.enabled.is_(True)))
    if not adapter:
        raise service_error("ADAPTER_UNAVAILABLE", "No supported adapter is available", http_status=503, retryable=True)
    from app.services.form_service_registry import RegistryResolution
    task = create_task(db, user.id, RegistryResolution(service, portal, adapter, 1), chat_id=payload.chat_id, original_request=payload.original_request, execution_mode=payload.execution_mode, timezone=payload.timezone, locale=payload.locale, client_request_id=payload.client_request_id)
    return build_task_view(db, task)


@router.get("/tasks", response_model=TaskListResponse)
def get_service_tasks(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100), state: str | None = Query(default=None, max_length=64), q: str | None = Query(default=None, max_length=100), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items, total = list_tasks(db, user.id, page=page, page_size=page_size, state=state, search=q)
    return TaskListResponse(items=items, page=page, page_size=page_size, total=total, has_more=page * page_size < total)


@router.get("/tasks/{task_id}", response_model=ServiceTaskView)
def get_service_task(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return build_task_view(db, get_owned_task(db, user.id, task_id))


@router.post("/tasks/{task_id}/start", response_model=ServiceTaskView)
def start_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    start_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/requirements")
def get_requirements(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    service = db.get(ServiceDefinition, task.service_id)
    return {"service_id": task.service_id, "information": service.requirements if service else [], "documents": service.required_documents if service else [], "eligibility": service.eligibility_rules if service else [], "fee": service.fee if service else {}}


@router.post("/tasks/{task_id}/fields", response_model=ServiceTaskView)
def save_requested_fields(task_id: str, payload: FieldsSubmitRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    submit_fields(db, task, data_request_id=payload.data_request_id, values=payload.values, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/documents", response_model=ServiceTaskView)
async def upload_requested_document(
    task_id: str,
    requirement_id: str = Form(...),
    version: int = Form(...),
    request_id: str = Form(...),
    save_to_vault: bool = Form(False),
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = get_owned_task(db, user.id, task_id)
    requirement = db.scalar(select(DocumentRequirement).where(DocumentRequirement.id == requirement_id, DocumentRequirement.task_id == task.id, DocumentRequirement.user_id == user.id))
    if not requirement:
        raise service_error("DOCUMENT_REQUIRED", "Document requirement not found", http_status=404)
    inspected = await inspect_and_store_upload(file, user.id, accepted=requirement.accepted_mime_types, max_bytes=requirement.max_bytes)
    document = Document(user_id=user.id, chat_id=task.chat_id, filename=inspected.filename, content_type=inspected.content_type, file_size=inspected.size, file_path=inspected.path, extracted_text="", summary=None, document_metadata={"form_service_task_id": task.id, "private": True, "sha256": inspected.sha256, "scanner": inspected.scanner_result, "page_count": inspected.page_count, "image_dimensions": inspected.dimensions, "embedded_text_retained": False})
    try:
        if save_to_vault:
            library_asset = upsert_library_asset(db, user_id=user.id, filename=inspected.filename, declared_mime=inspected.content_type, data=Path(inspected.path).read_bytes(), source="upload", pre_extracted=("", {"scanner": inspected.scanner_result}), extra_metadata={"form_service_task_id": task.id, "requirement_id": requirement.id, "embedded_text_retained": False})
            document.document_metadata = {**document.document_metadata, "library_asset_id": library_asset.id, "vault_saved": True}
        db.add(document)
        db.flush()
        attach_document(db, task, requirement=requirement, document=document, inspected=inspected, save_to_vault=save_to_vault, expected_version=version, request_id=request_id)
    except Exception:
        db.rollback()
        Path(inspected.path).unlink(missing_ok=True)
        raise
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/documents/from-vault", response_model=ServiceTaskView)
async def attach_document_from_vault(task_id: str, payload: VaultDocumentAttachRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    requirement = db.scalar(select(DocumentRequirement).where(DocumentRequirement.id == payload.requirement_id, DocumentRequirement.task_id == task.id, DocumentRequirement.user_id == user.id))
    asset = db.scalar(select(LibraryAsset).where(LibraryAsset.id == payload.library_asset_id, LibraryAsset.user_id == user.id, LibraryAsset.is_deleted.is_(False)))
    if not requirement:
        raise service_error("DOCUMENT_REQUIRED", "Document requirement not found", http_status=404)
    if not asset:
        raise service_error("SERVICE_NOT_FOUND", "Vault document not found", http_status=404)
    try:
        content = await asyncio.to_thread(library_storage.read, asset.storage_key)
    except Exception as exc:
        raise service_error("DOCUMENT_INVALID", "Vault document content is unavailable", http_status=404) from exc
    upload = UploadFile(file=BytesIO(content), filename=asset.display_name, headers=Headers({"content-type": asset.mime_type}))
    inspected = await inspect_and_store_upload(upload, user.id, accepted=requirement.accepted_mime_types, max_bytes=requirement.max_bytes)
    document = Document(user_id=user.id, chat_id=task.chat_id, filename=inspected.filename, content_type=inspected.content_type, file_size=inspected.size, file_path=inspected.path, extracted_text="", summary=None, document_metadata={"form_service_task_id": task.id, "private": True, "sha256": inspected.sha256, "scanner": inspected.scanner_result, "page_count": inspected.page_count, "image_dimensions": inspected.dimensions, "library_asset_id": asset.id, "vault_saved": True, "embedded_text_retained": False})
    try:
        db.add(document)
        db.flush()
        attach_document(db, task, requirement=requirement, document=document, inspected=inspected, save_to_vault=True, expected_version=payload.version, request_id=payload.request_id)
    except Exception:
        db.rollback()
        Path(inspected.path).unlink(missing_ok=True)
        raise
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/documents/{asset_id}")
def inspect_document(task_id: str, asset_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    asset = db.scalar(select(ServiceDocumentAsset).where(ServiceDocumentAsset.id == asset_id, ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == user.id))
    if not asset:
        raise service_error("SERVICE_NOT_FOUND", "Document asset not found", http_status=404)
    analysis = db.scalar(select(DocumentAnalysis).where(DocumentAnalysis.asset_id == asset.id, DocumentAnalysis.user_id == user.id))
    return {"asset_id": asset.id, "validation_status": asset.validation_status, "detected_type": asset.detected_type, "warnings": asset.warnings, "analysis": analysis}


@router.post("/tasks/{task_id}/documents/{asset_id}/ocr", response_model=ServiceTaskView)
def run_document_ocr(task_id: str, asset_id: str, payload: DocumentOcrRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    row = db.execute(select(ServiceDocumentAsset, Document).join(Document, Document.id == ServiceDocumentAsset.document_id).where(ServiceDocumentAsset.id == asset_id, ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == user.id, Document.user_id == user.id)).first()
    if not row:
        raise service_error("SERVICE_NOT_FOUND", "Document asset not found", http_status=404)
    asset, document = row
    analysis = db.scalar(select(DocumentAnalysis).where(DocumentAnalysis.asset_id == asset.id, DocumentAnalysis.user_id == user.id))
    if not analysis:
        raise service_error("SERVICE_NOT_FOUND", "Document analysis not found", http_status=404)
    analyze_document_ocr(db, task, asset, document, analysis, cloud_processing_accepted=payload.cloud_processing_accepted, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/documents/{asset_id}/content")
def read_document_content(task_id: str, asset_id: str, expires: int = Query(...), signature: str = Query(..., min_length=64, max_length=64), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    if expires < int(datetime.utcnow().timestamp()) or expires > int((datetime.utcnow() + timedelta(minutes=10)).timestamp()):
        raise service_error("SESSION_EXPIRED", "Document preview link expired", http_status=410)
    if not valid_document_access_signature(user.id, task.id, asset_id, expires, signature):
        raise service_error("POLICY_BLOCKED", "Document preview signature is invalid", http_status=403)
    row = db.execute(select(ServiceDocumentAsset, Document).join(Document, Document.id == ServiceDocumentAsset.document_id).where(ServiceDocumentAsset.id == asset_id, ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == user.id, Document.user_id == user.id)).first()
    if not row:
        raise service_error("SERVICE_NOT_FOUND", "Document asset not found", http_status=404)
    asset, document = row
    del asset
    path = Path(document.file_path).resolve()
    storage_root = Path(settings.FORM_SERVICE_STORAGE_DIR).resolve()
    if storage_root not in path.parents or not path.is_file():
        raise service_error("DOCUMENT_INVALID", "Private document file is unavailable", http_status=404)
    return FileResponse(path, media_type=document.content_type, filename=document.filename, content_disposition_type="inline", headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.post("/tasks/{task_id}/documents/{asset_id}/analysis", response_model=ServiceTaskView)
def decide_document_analysis(task_id: str, asset_id: str, payload: AnalysisDecisionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    ensure_version(task, payload.version)
    asset = db.scalar(select(ServiceDocumentAsset).where(ServiceDocumentAsset.id == asset_id, ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == user.id))
    analysis = db.scalar(select(DocumentAnalysis).where(DocumentAnalysis.asset_id == asset_id, DocumentAnalysis.user_id == user.id))
    if not asset or not analysis:
        raise service_error("SERVICE_NOT_FOUND", "Document analysis not found", http_status=404)
    decide_document_analysis(db, task, asset, analysis, accepted=payload.accepted, accepted_fields=payload.accepted_fields, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.delete("/tasks/{task_id}/documents/{asset_id}", response_model=ServiceTaskView)
def delete_requested_document(task_id: str, asset_id: str, version: int = Query(..., ge=1), request_id: str = Query(..., min_length=8, max_length=120), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    asset = db.scalar(select(ServiceDocumentAsset).where(ServiceDocumentAsset.id == asset_id, ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == user.id))
    if not asset:
        raise service_error("SERVICE_NOT_FOUND", "Document asset not found", http_status=404)
    remove_document(db, task, asset, expected_version=version, request_id=request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/permissions", response_model=ServiceTaskView)
def create_permission(task_id: str, payload: PermissionCreateRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    request_permission(db, task, capability=payload.capability, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/permissions/{permission_id}/resolve", response_model=ServiceTaskView)
def record_permission(task_id: str, permission_id: str, payload: PermissionResolveRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    permission = db.scalar(select(PermissionRequest).where(PermissionRequest.id == permission_id, PermissionRequest.task_id == task.id, PermissionRequest.user_id == user.id))
    if not permission:
        raise service_error("SERVICE_NOT_FOUND", "Permission request not found", http_status=404)
    resolve_permission(db, task, permission, native_status=payload.native_status, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/consents", response_model=ServiceTaskView)
def grant_consent(task_id: str, payload: ConsentRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    ensure_version(task, payload.version)
    grant = ConsentGrant(task_id=task.id, user_id=user.id, purpose=payload.purpose, data_scope=payload.data_scope, status="ACTIVE", expires_at=datetime.utcnow() + timedelta(minutes=payload.expires_in_minutes) if payload.expires_in_minutes else None)
    db.add(grant)
    task.version += 1
    append_audit_event(db, task, "CONSENT_GRANTED", {"grant_id": grant.id, "purpose": payload.purpose, "data_scope": payload.data_scope}, payload.request_id)
    db.commit()
    return build_task_view(db, task)


@router.delete("/tasks/{task_id}/consents", response_model=ServiceTaskView)
def delete_consent(task_id: str, version: int = Query(..., ge=1), request_id: str = Query(..., min_length=8, max_length=120), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    revoke_consent(db, task, expected_version=version, request_id=request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/prepare", response_model=ServiceTaskView)
def prepare_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    prepare_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/review")
def get_review(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    view = build_task_view(db, task)
    if view.active_card.type.value != "form_review":
        raise service_error("POLICY_BLOCKED", "A validated review is not currently available")
    return view.active_card


@router.post("/tasks/{task_id}/confirmation", response_model=ServiceTaskView)
def confirm_service_submission(task_id: str, payload: ConfirmationRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    confirm_submission(db, task, expected_version=payload.version, declaration_accepted=payload.declaration_accepted, device_confirmation=payload.device_confirmation, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/approve-review", response_model=ServiceTaskView)
def approve_service_review(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    approve_review(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/review-again", response_model=ServiceTaskView)
def reopen_review(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    review_again(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/edit", response_model=ServiceTaskView)
def edit_service_information(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    edit_task_information(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/edit-documents", response_model=ServiceTaskView)
def edit_service_documents(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    reopen_documents(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/submit", response_model=ServiceTaskView)
def execute_submission(task_id: str, payload: SubmissionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    submit_task(db, task, confirmation_id=payload.confirmation_id, idempotency_key=payload.idempotency_key, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/portal-session", response_model=ServiceTaskView)
def open_portal_session(task_id: str, payload: PortalSessionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    create_portal_session(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/portal-session")
def get_portal_session(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    session = db.scalar(select(PortalSession).where(PortalSession.task_id == task.id, PortalSession.user_id == user.id))
    if not session:
        raise service_error("SERVICE_NOT_FOUND", "Portal session not found", http_status=404)
    return {"id": session.id, "status": session.status, "mode": session.mode, "current_step": session.current_step, "user_action_required": session.user_action_required, "last_activity_at": session.last_activity_at, "expires_at": session.expires_at}


@router.post("/tasks/{task_id}/portal-outcome", response_model=ServiceTaskView)
def save_portal_outcome(task_id: str, payload: PortalOutcomeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    report_portal_outcome(db, task, application_id=payload.application_id, transaction_id=payload.transaction_id, user_reported_status=payload.user_reported_status, idempotency_key=payload.idempotency_key, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/secure-challenges", response_model=ServiceTaskView)
def create_secure_challenge(task_id: str, payload: SecureChallengeRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    request_secure_challenge(db, task, kind=payload.kind, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/secure-challenges/{challenge_id}/response", response_model=ServiceTaskView)
def submit_secure_response(task_id: str, challenge_id: str, payload: SecureResponseRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    challenge = db.scalar(select(ServiceSecureChallenge).where(ServiceSecureChallenge.id == challenge_id, ServiceSecureChallenge.task_id == task.id, ServiceSecureChallenge.user_id == user.id))
    if not challenge:
        raise service_error("SERVICE_NOT_FOUND", "Secure challenge not found", http_status=404)
    consume_secure_response(db, task, challenge, secret=payload.secret, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/human-action", response_model=ServiceTaskView)
def finish_human_action(task_id: str, payload: HumanActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    complete_human_action(db, task, action=payload.action, completed=payload.completed, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/receipt")
def get_receipt(task_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    receipt = db.scalar(select(ServiceActionReceipt).where(ServiceActionReceipt.task_id == task.id, ServiceActionReceipt.user_id == user.id))
    if not receipt:
        raise service_error("SERVICE_NOT_FOUND", "Action receipt not found", http_status=404)
    evidence = list(db.scalars(select(ReceiptEvidence).where(ReceiptEvidence.receipt_id == receipt.id, ReceiptEvidence.user_id == user.id)))
    return {"receipt": receipt, "evidence": evidence}


@router.post("/tasks/{task_id}/track")
def track_service_task(task_id: str, request_id: str = Query(..., min_length=8, max_length=120), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return track_task(db, get_owned_task(db, user.id, task_id), request_id=request_id)


@router.post("/tasks/{task_id}/pause", response_model=ServiceTaskView)
def pause_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    pause_task(db, task, expected_version=payload.version, request_id=payload.request_id, reason=payload.reason)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/resume", response_model=ServiceTaskView)
def resume_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    resume_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/cancel", response_model=ServiceTaskView)
def cancel_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    cancel_task(db, task, expected_version=payload.version, request_id=payload.request_id, reason=payload.reason)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/retry", response_model=ServiceTaskView)
def retry_service_task(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    retry_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/verify", response_model=ServiceTaskView)
def verify_service_outcome(task_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    retry_task(db, task, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.post("/tasks/{task_id}/handoff")
def request_human_handoff(task_id: str, payload: HandoffRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    return create_handoff(db, task, approved_field_keys=payload.approved_field_keys, approved_document_ids=payload.approved_document_ids, purpose=payload.purpose, expected_version=payload.version, request_id=payload.request_id)


@router.post("/tasks/{task_id}/handoff/{handoff_id}/revoke", response_model=ServiceTaskView)
def revoke_human_handoff(task_id: str, handoff_id: str, payload: TaskActionRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    task = get_owned_task(db, user.id, task_id)
    revoke_handoff(db, task, handoff_id, expected_version=payload.version, request_id=payload.request_id)
    return build_task_view(db, task)


@router.get("/tasks/{task_id}/events")
def stream_task_events(task_id: str, after: str | None = Query(default=None), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    get_owned_task(db, user.id, task_id)
    user_id = user.id

    async def event_stream():
        last_id = after
        idle_rounds = 0
        while idle_rounds < 15:
            with SessionLocal() as event_db:
                query = select(ServiceAuditEvent).where(ServiceAuditEvent.task_id == task_id, ServiceAuditEvent.user_id == user_id).order_by(ServiceAuditEvent.created_at, ServiceAuditEvent.id)
                rows = list(event_db.scalars(query.limit(200)))
                if last_id:
                    ids = [item.id for item in rows]
                    rows = rows[ids.index(last_id) + 1:] if last_id in ids else rows
                if rows:
                    for row in rows:
                        last_id = row.id
                        payload = {"id": row.id, "event_type": row.event_type, "details": row.details, "request_id": row.request_id, "created_at": row.created_at.isoformat() + "Z"}
                        yield f"id: {row.id}\nevent: task_update\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"
                    idle_rounds = 0
                else:
                    idle_rounds += 1
                    yield ": keep-alive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
