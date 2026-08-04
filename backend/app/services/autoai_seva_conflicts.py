from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.autoai_seva import ServiceFieldConflict
from app.models.form_service import (
    DocumentAnalysis,
    ServiceDocumentAsset,
    ServiceTask,
    UserFieldResponse,
)
from app.services.autoai_seva_review import invalidate_review_binding
from app.services.form_service_state import append_audit_event
from app.services.sensitive_data import decrypt_sensitive_text, encrypt_sensitive_text


ALLOWED_RESOLUTION_SOURCES = {"user", "document", "manual"}
RESOLVABLE_STATES = {"COLLECTING_DOCUMENTS", "READY_TO_PREPARE"}


def _normalized(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).strip().casefold().split())


def _raw_field_value(row: UserFieldResponse) -> Any:
    if row.encrypted_value:
        return decrypt_sensitive_text(row.encrypted_value)
    return (row.value_json or {}).get("value")


def _confidence(candidate: dict[str, Any]) -> float:
    raw = candidate.get("confidence", candidate.get("score", 0.75))
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 0.75
    if value > 1:
        value /= 100
    return max(0.0, min(1.0, value))


def _confidence_band(value: float) -> str:
    if value >= 0.9:
        return "HIGH"
    if value >= 0.7:
        return "MEDIUM"
    return "LOW"


def _mask(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "Missing"
    if len(text) <= 4:
        return "•" * len(text)
    return f"{text[:2]}{'•' * min(8, max(3, len(text) - 4))}{text[-2:]}"


def _decrypt_candidates(conflict: ServiceFieldConflict) -> dict[str, Any]:
    if not conflict.encrypted_candidate_values:
        return {}
    try:
        return json.loads(decrypt_sensitive_text(conflict.encrypted_candidate_values))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}


def conflict_view(conflict: ServiceFieldConflict, *, reveal_values: bool = True) -> dict[str, Any]:
    values = _decrypt_candidates(conflict) if reveal_values else {}
    return {
        "id": conflict.id,
        "task_id": conflict.task_id,
        "field_key": conflict.field_key,
        "source_document_id": conflict.source_document_id,
        "conflict_type": conflict.conflict_type,
        "candidate_summary": conflict.candidate_summary or {},
        "candidate_values": values,
        "resolution_state": conflict.resolution_state,
        "selected_source": conflict.selected_source,
        "resolution_note": conflict.resolution_note,
        "resolved_at": conflict.resolved_at,
        "created_at": conflict.created_at,
        "updated_at": conflict.updated_at,
    }


def scan_task_conflicts(
    db: Session,
    task: ServiceTask,
    *,
    request_id: str,
) -> list[ServiceFieldConflict]:
    responses = {
        row.field_key: row
        for row in db.scalars(
            select(UserFieldResponse).where(
                UserFieldResponse.task_id == task.id,
                UserFieldResponse.user_id == task.user_id,
            )
        )
    }
    rows = db.execute(
        select(ServiceDocumentAsset, DocumentAnalysis)
        .join(DocumentAnalysis, DocumentAnalysis.asset_id == ServiceDocumentAsset.id)
        .where(
            ServiceDocumentAsset.task_id == task.id,
            ServiceDocumentAsset.user_id == task.user_id,
            DocumentAnalysis.user_id == task.user_id,
        )
    ).all()
    created: list[ServiceFieldConflict] = []
    for asset, analysis in rows:
        for field_key, candidate in (analysis.extracted_fields or {}).items():
            response = responses.get(field_key)
            if not response or not isinstance(candidate, dict):
                continue
            user_value = _raw_field_value(response)
            document_value = candidate.get("value")
            if not _normalized(user_value) or _normalized(user_value) == _normalized(document_value):
                continue
            existing = db.scalar(
                select(ServiceFieldConflict).where(
                    ServiceFieldConflict.task_id == task.id,
                    ServiceFieldConflict.user_id == task.user_id,
                    ServiceFieldConflict.field_key == field_key,
                    ServiceFieldConflict.source_document_id == asset.id,
                    ServiceFieldConflict.resolution_state == "OPEN",
                )
            )
            if existing:
                created.append(existing)
                continue
            confidence = _confidence(candidate)
            conflict = ServiceFieldConflict(
                task_id=task.id,
                user_id=task.user_id,
                field_key=field_key,
                source_document_id=asset.id,
                conflict_type="VALUE_MISMATCH",
                candidate_summary={
                    "user_value_masked": _mask(user_value),
                    "document_value_masked": _mask(document_value),
                    "document_confidence": confidence,
                    "confidence_band": _confidence_band(confidence),
                    "document_analysis_id": analysis.id,
                },
                encrypted_candidate_values=encrypt_sensitive_text(
                    json.dumps(
                        {"user": user_value, "document": document_value},
                        ensure_ascii=False,
                        default=str,
                    )
                ),
            )
            db.add(conflict)
            db.flush()
            created.append(conflict)
    append_audit_event(
        db,
        task,
        "FIELD_CONFLICT_SCAN_COMPLETED",
        {"open_conflict_count": len(created), "field_keys": sorted({item.field_key for item in created})},
        request_id,
    )
    db.commit()
    return created


def list_task_conflicts(db: Session, task: ServiceTask) -> list[ServiceFieldConflict]:
    return list(
        db.scalars(
            select(ServiceFieldConflict)
            .where(
                ServiceFieldConflict.task_id == task.id,
                ServiceFieldConflict.user_id == task.user_id,
            )
            .order_by(ServiceFieldConflict.created_at, ServiceFieldConflict.id)
        )
    )


def get_owned_conflict(
    db: Session,
    task: ServiceTask,
    conflict_id: str,
) -> ServiceFieldConflict | None:
    return db.scalar(
        select(ServiceFieldConflict).where(
            ServiceFieldConflict.id == conflict_id,
            ServiceFieldConflict.task_id == task.id,
            ServiceFieldConflict.user_id == task.user_id,
        )
    )


def resolve_field_conflict(
    db: Session,
    task: ServiceTask,
    conflict: ServiceFieldConflict,
    *,
    selected_source: str,
    manual_value: Any = None,
    resolution_note: str | None = None,
    request_id: str,
) -> ServiceFieldConflict:
    if task.state not in RESOLVABLE_STATES:
        raise ValueError("Conflicts must be resolved before final review is prepared.")
    if conflict.resolution_state != "OPEN":
        return conflict
    if selected_source not in ALLOWED_RESOLUTION_SOURCES:
        raise ValueError("selected_source must be user, document, or manual")
    values = _decrypt_candidates(conflict)
    if selected_source == "user":
        selected_value = values.get("user")
    elif selected_source == "document":
        selected_value = values.get("document")
    else:
        if manual_value in (None, ""):
            raise ValueError("manual_value is required for manual conflict resolution")
        selected_value = manual_value

    response = db.scalar(
        select(UserFieldResponse).where(
            UserFieldResponse.task_id == task.id,
            UserFieldResponse.user_id == task.user_id,
            UserFieldResponse.field_key == conflict.field_key,
        )
    )
    if not response:
        raise ValueError("The conflicting field is no longer available.")
    metadata = dict(response.value_json or {})
    provenance = {
        "source_document_id": conflict.source_document_id if selected_source == "document" else None,
        "extraction_confidence": (conflict.candidate_summary or {}).get("document_confidence") if selected_source == "document" else 1.0,
        "verification_status": "USER_CONFIRMED",
        "user_confirmed": True,
        "conflict_id": conflict.id,
    }
    if response.sensitivity in {"sensitive", "high"}:
        response.encrypted_value = encrypt_sensitive_text(str(selected_value))
        response.value_json = {"present": True, **provenance}
    else:
        response.encrypted_value = None
        response.value_json = {"value": selected_value, **provenance}
    response.source = selected_source
    response.verified = True
    response.version += 1

    conflict.resolution_state = "RESOLVED"
    conflict.selected_source = selected_source
    conflict.resolution_note = (resolution_note or "User selected the authoritative value")[:240]
    conflict.resolved_at = datetime.utcnow()
    task.version += 1
    invalidate_review_binding(db, task.id, task.user_id)
    append_audit_event(
        db,
        task,
        "FIELD_CONFLICT_RESOLVED",
        {
            "conflict_id": conflict.id,
            "field_key": conflict.field_key,
            "selected_source": selected_source,
            "raw_values_logged": False,
        },
        request_id,
    )
    db.commit()
    db.refresh(conflict)
    return conflict
