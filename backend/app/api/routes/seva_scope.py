from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.autoai_seva import SevaAgentProfile, SevaWorkOrder
from app.models.document import Document
from app.models.form_service import ServiceDefinition, ServiceDocumentAsset, ServiceTask, UserFieldResponse
from app.models.user import User
from app.services.sensitive_data import decrypt_sensitive_text
from app.services.seva_assignment import case_event


router = APIRouter(prefix="/seva-operations/admin/work-orders", tags=["autoai-seva-scope"])

SECRET_WORDS = ("password", "passcode", "otp", "pin", "captcha", "cvv", "secret", "token", "recovery_code")


def _seva_employee(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> User:
    if user.is_admin and user.role in {"admin", "super_admin", "administrator"}:
        return user
    profile = db.scalar(select(SevaAgentProfile).where(
        SevaAgentProfile.user_id == user.id, SevaAgentProfile.is_active.is_(True)
    ))
    if (
        not profile or user.role != "seva_agent" or profile.status != "ACTIVE"
        or profile.must_change_password
    ):
        raise HTTPException(status_code=403, detail="Active Seva agent access required")
    return user


def _assigned_work_order(db: Session, work_order_id: str, employee: User) -> SevaWorkOrder:
    work_order = db.get(SevaWorkOrder, work_order_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Seva work order not found")
    if work_order.assigned_employee_id != employee.id:
        raise HTTPException(status_code=403, detail="Claim this work order before viewing user-approved data")
    if work_order.status == "CANCELLED":
        raise HTTPException(status_code=403, detail="The user revoked employee access")
    return work_order


def _approved_scope(work_order: SevaWorkOrder) -> tuple[set[str], set[str]]:
    scope = work_order.user_consent_scope or {}
    fields = {
        str(key)
        for key in scope.get("field_keys", [])
        if key and not any(word in str(key).casefold() for word in SECRET_WORDS)
    }
    documents = {str(item) for item in scope.get("document_ids", []) if item}
    return fields, documents


@router.get("/{work_order_id}/scope")
def get_approved_scope(
    work_order_id: str,
    employee: User = Depends(_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _assigned_work_order(db, work_order_id, employee)
    task = db.get(ServiceTask, work_order.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Application task not found")
    service = db.get(ServiceDefinition, task.service_id)
    approved_fields, approved_documents = _approved_scope(work_order)
    definitions = {
        str(item.get("key")): str(item.get("label") or item.get("key"))
        for item in (service.requirements if service else [])
    }
    rows = list(
        db.scalars(
            select(UserFieldResponse).where(
                UserFieldResponse.task_id == task.id,
                UserFieldResponse.user_id == task.user_id,
                UserFieldResponse.field_key.in_(approved_fields),
            )
        )
    ) if approved_fields else []
    fields = []
    for row in rows:
        if any(word in row.field_key.casefold() for word in SECRET_WORDS):
            continue
        value = decrypt_sensitive_text(row.encrypted_value) if row.encrypted_value else (row.value_json or {}).get("value")
        fields.append(
            {
                "key": row.field_key,
                "label": definitions.get(row.field_key, row.field_key.replace("_", " ").title()),
                "value": value,
                "source": row.source,
                "verified": row.verified,
            }
        )

    assets = list(
        db.scalars(
            select(ServiceDocumentAsset).where(
                ServiceDocumentAsset.task_id == task.id,
                ServiceDocumentAsset.user_id == task.user_id,
                ServiceDocumentAsset.id.in_(approved_documents),
            )
        )
    ) if approved_documents else []
    documents = []
    for asset in assets:
        document = db.get(Document, asset.document_id)
        if not document:
            continue
        documents.append(
            {
                "asset_id": asset.id,
                "filename": document.filename,
                "content_type": document.content_type,
                "file_size": document.file_size,
                "validation_status": asset.validation_status,
                "download_path": f"/form-services/seva-operations/admin/work-orders/{work_order.id}/documents/{asset.id}/content",
            }
        )
    return {
        "work_order_id": work_order.id,
        "task_id": task.id,
        "service_name": service.name if service else "AutoAI Seva application",
        "fields": fields,
        "documents": documents,
        "authentication_secrets_shared": False,
    }


@router.get("/{work_order_id}/documents/{asset_id}/content")
def download_approved_document(
    work_order_id: str,
    asset_id: str,
    employee: User = Depends(_seva_employee),
    db: Session = Depends(get_db),
):
    work_order = _assigned_work_order(db, work_order_id, employee)
    _, approved_documents = _approved_scope(work_order)
    if asset_id not in approved_documents:
        raise HTTPException(status_code=404, detail="Approved document not found")
    asset = db.scalar(
        select(ServiceDocumentAsset).where(
            ServiceDocumentAsset.id == asset_id,
            ServiceDocumentAsset.task_id == work_order.task_id,
            ServiceDocumentAsset.user_id == work_order.user_id,
        )
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Approved document not found")
    document = db.get(Document, asset.document_id)
    if not document:
        raise HTTPException(status_code=404, detail="Document file not found")
    path = Path(document.file_path)
    if not path.is_file():
        raise HTTPException(status_code=410, detail="Document file is no longer available")
    case_event(db, work_order, "DOCUMENT_ACCESSED", "Approved document opened by assigned agent", actor_id=employee.id, visibility="INTERNAL", details={"asset_id": asset.id})
    db.commit()
    return FileResponse(path, media_type=document.content_type, filename=document.filename)
