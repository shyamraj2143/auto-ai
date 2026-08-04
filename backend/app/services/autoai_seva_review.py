from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Any

from sqlalchemy import event, inspect as sa_inspect, select
from sqlalchemy.orm import Session

from app.models.form_service import (
    ConsentGrant,
    DocumentRequirement,
    FormDraft,
    PortalAdapterRecord,
    ServiceDefinition,
    ServiceDocumentAsset,
    ServiceTask,
    SubmissionConfirmation,
    UserFieldResponse,
)


FINAL_CONSENT_TYPE = "FINAL_SUBMISSION"
NOTICE_VERSION = "autoai-seva-final-v1"
DECLARATION_VERSION = "autoai-seva-declaration-v1"
_MARKER_RE = re.compile(r"\n?\[AutoAI review hash: ([a-f0-9]{64})\]", re.IGNORECASE)

PUBLIC_STATE_MAP = {
    "CREATED": "CREATED",
    "INTENT_CONFIRMED": "DISCOVERING_SERVICE",
    "SERVICE_DISCOVERY": "DISCOVERING_SERVICE",
    "REQUIREMENTS_READY": "REQUIREMENTS_READY",
    "COLLECTING_INFORMATION": "COLLECTING_INFORMATION",
    "COLLECTING_DOCUMENTS": "COLLECTING_DOCUMENTS",
    "AWAITING_PERMISSION": "AWAITING_PERMISSION",
    "AWAITING_AUTHENTICATION": "AWAITING_USER_VERIFICATION",
    "READY_TO_PREPARE": "READY_TO_PREPARE",
    "PREPARING": "PREPARING_APPLICATION",
    "VALIDATING": "VALIDATING_APPLICATION",
    "REVIEW_REQUIRED": "REVIEW_REQUIRED",
    "SUBMISSION_CONFIRMATION_REQUIRED": "AWAITING_FINAL_CONSENT",
    "PORTAL_SESSION_ACTIVE": "OFFICIAL_PORTAL_ACTIVE",
    "AWAITING_USER_ACTION": "AWAITING_USER_PORTAL_ACTION",
    "SUBMITTING": "SUBMITTING",
    "SUBMITTED_UNVERIFIED": "SUBMITTED_PENDING_VERIFICATION",
    "VERIFYING": "VERIFYING_SUBMISSION",
    "COMPLETED_VERIFIED": "COMPLETED",
    "FAILED_RECOVERABLE": "NEEDS_ATTENTION",
    "FAILED_FINAL": "FAILED",
    "PAUSED": "PAUSED",
    "CANCELLED": "CANCELLED",
    "EXPIRED": "EXPIRED",
}


class ReviewBindingError(ValueError):
    pass


def public_state(state: str) -> str:
    return PUBLIC_STATE_MAP.get(state, state)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def _confirmation_hash(confirmation: SubmissionConfirmation) -> str | None:
    match = _MARKER_RE.search(confirmation.declaration or "")
    return match.group(1).lower() if match else None


def _bind_declaration(declaration: str, review_hash: str) -> str:
    base = _MARKER_RE.sub("", declaration or "").strip()
    return f"{base}\n[AutoAI review hash: {review_hash}]"


def _field_payload(row: UserFieldResponse) -> dict[str, Any]:
    if row.encrypted_value:
        value: Any = {"encrypted_digest": hashlib.sha256(row.encrypted_value.encode("utf-8")).hexdigest()}
    else:
        value = row.value_json or {}
    return {
        "key": row.field_key,
        "value": value,
        "source": row.source,
        "verified": bool(row.verified),
        "version": row.version,
        "sensitivity": row.sensitivity,
    }


def compute_review_hash(db: Session, task: ServiceTask) -> str:
    service = db.get(ServiceDefinition, task.service_id)
    adapter = db.get(PortalAdapterRecord, task.adapter_id)
    fields = list(
        db.scalars(
            select(UserFieldResponse)
            .where(UserFieldResponse.task_id == task.id, UserFieldResponse.user_id == task.user_id)
            .order_by(UserFieldResponse.field_key)
        )
    )
    documents = db.execute(
        select(ServiceDocumentAsset, DocumentRequirement)
        .join(DocumentRequirement, DocumentRequirement.id == ServiceDocumentAsset.requirement_id)
        .where(ServiceDocumentAsset.task_id == task.id, ServiceDocumentAsset.user_id == task.user_id)
        .order_by(DocumentRequirement.requirement_key, ServiceDocumentAsset.sha256)
    ).all()
    service_metadata = dict(service.support_contact or {}) if service else {}
    adapter_configuration = dict(adapter.configuration or {}) if adapter else {}
    payload = {
        "declaration_version": DECLARATION_VERSION,
        "service": {
            "id": task.service_id,
            "code": service_metadata.get("service_code", task.service_id),
            "catalogue_version": service_metadata.get("catalogue_version", "legacy-v1"),
            "adapter_key": adapter.adapter_key if adapter else None,
            "adapter_version": adapter_configuration.get("adapter_version", "1"),
        },
        "execution_mode": task.execution_mode,
        "portal_id": task.portal_id,
        "fields": [_field_payload(row) for row in fields],
        "documents": [
            {
                "requirement_key": requirement.requirement_key,
                "sha256": asset.sha256,
                "validation_status": asset.validation_status,
                "detected_type": asset.detected_type,
                "warnings": sorted(str(item) for item in (asset.warnings or [])),
            }
            for asset, requirement in documents
        ],
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _store_review_hash(db: Session, task: ServiceTask, review_hash: str) -> None:
    draft = db.scalar(
        select(FormDraft).where(FormDraft.task_id == task.id, FormDraft.user_id == task.user_id)
    )
    if not draft:
        return
    summary = dict(draft.summary or {})
    summary["autoai_seva_review"] = {
        "review_hash": review_hash,
        "declaration_version": DECLARATION_VERSION,
        "notice_version": NOTICE_VERSION,
        "generated_at": datetime.utcnow().isoformat(),
    }
    draft.summary = summary


def _matching_final_consent(
    db: Session,
    task: ServiceTask,
    review_hash: str,
) -> ConsentGrant | None:
    now = datetime.utcnow()
    grants = list(
        db.scalars(
            select(ConsentGrant)
            .where(
                ConsentGrant.task_id == task.id,
                ConsentGrant.user_id == task.user_id,
                ConsentGrant.status == "ACTIVE",
                ConsentGrant.purpose == FINAL_CONSENT_TYPE,
            )
            .order_by(ConsentGrant.created_at.desc())
        )
    )
    needle = f"review_hash:{review_hash}"
    for grant in grants:
        if grant.expires_at and grant.expires_at <= now:
            grant.status = "EXPIRED"
            continue
        if needle in (grant.data_scope or []) and f"notice_version:{NOTICE_VERSION}" in (grant.data_scope or []):
            return grant
    return None


def ensure_final_consent(
    db: Session,
    task: ServiceTask,
    confirmation: SubmissionConfirmation,
) -> ConsentGrant:
    review_hash = _confirmation_hash(confirmation)
    current_hash = compute_review_hash(db, task)
    if not review_hash or review_hash != current_hash:
        raise ReviewBindingError("The reviewed application changed. Review and confirm the current version again.")
    existing = _matching_final_consent(db, task, review_hash)
    if existing:
        return existing
    grant = ConsentGrant(
        task_id=task.id,
        user_id=task.user_id,
        purpose=FINAL_CONSENT_TYPE,
        data_scope=[
            f"review_hash:{review_hash}",
            f"notice_version:{NOTICE_VERSION}",
            f"declaration_version:{DECLARATION_VERSION}",
            "action:submit_exact_reviewed_application",
        ],
        status="ACTIVE",
        expires_at=confirmation.expires_at,
    )
    db.add(grant)
    return grant


def validate_review_binding(
    db: Session,
    task: ServiceTask,
    confirmation: SubmissionConfirmation,
) -> tuple[bool, str]:
    review_hash = _confirmation_hash(confirmation)
    if not review_hash:
        return False, "The confirmation is not bound to a reviewed application hash."
    if review_hash != compute_review_hash(db, task):
        return False, "The application changed after review. Review and confirm it again."
    if not _matching_final_consent(db, task, review_hash):
        return False, "Final submission consent for this exact reviewed application is missing or expired."
    return True, "Review hash and final consent match the current application."


def invalidate_review_binding(db: Session, task_id: str, user_id: str) -> None:
    confirmations = list(
        db.scalars(
            select(SubmissionConfirmation).where(
                SubmissionConfirmation.task_id == task_id,
                SubmissionConfirmation.user_id == user_id,
                SubmissionConfirmation.status.in_(["PENDING", "CONFIRMED"]),
            )
        )
    )
    for confirmation in confirmations:
        confirmation.status = "SUPERSEDED"
    grants = list(
        db.scalars(
            select(ConsentGrant).where(
                ConsentGrant.task_id == task_id,
                ConsentGrant.user_id == user_id,
                ConsentGrant.purpose == FINAL_CONSENT_TYPE,
                ConsentGrant.status == "ACTIVE",
            )
        )
    )
    for grant in grants:
        grant.status = "REVOKED"
        grant.revoked_at = datetime.utcnow()
    draft = db.scalar(
        select(FormDraft).where(FormDraft.task_id == task_id, FormDraft.user_id == user_id)
    )
    if draft and "autoai_seva_review" in (draft.summary or {}):
        summary = dict(draft.summary or {})
        summary.pop("autoai_seva_review", None)
        draft.summary = summary


def _response_changed(row: UserFieldResponse) -> bool:
    state = sa_inspect(row)
    if state.pending:
        return True
    return any(
        state.attrs[name].history.has_changes()
        for name in ("value_json", "encrypted_value", "source", "verified", "version")
    )


def _asset_changed(asset: ServiceDocumentAsset) -> bool:
    state = sa_inspect(asset)
    if state.pending or state.deleted:
        return True
    return any(
        state.attrs[name].history.has_changes()
        for name in ("sha256", "validation_status", "warnings", "document_id", "requirement_id")
    )


@event.listens_for(Session, "before_flush")
def _apply_review_binding(session: Session, _flush_context: Any, _instances: Any) -> None:
    changed_tasks: set[tuple[str, str]] = set()

    for row in list(session.new) + list(session.dirty):
        if isinstance(row, UserFieldResponse):
            metadata = dict(row.value_json or {})
            if row.source == "user":
                enriched = {
                    **metadata,
                    "source_document_id": metadata.get("source_document_id"),
                    "extraction_confidence": metadata.get("extraction_confidence", 1.0),
                    "verification_status": metadata.get("verification_status", "USER_CONFIRMED"),
                    "user_confirmed": True,
                }
                if enriched != metadata:
                    row.value_json = enriched
                row.verified = True
            if _response_changed(row):
                changed_tasks.add((row.task_id, row.user_id))

    for asset in list(session.new) + list(session.dirty) + list(session.deleted):
        if isinstance(asset, ServiceDocumentAsset) and _asset_changed(asset):
            changed_tasks.add((asset.task_id, asset.user_id))

    with session.no_autoflush:
        for task_id, user_id in changed_tasks:
            invalidate_review_binding(session, task_id, user_id)

        confirmations = [
            item
            for item in list(session.new) + list(session.dirty)
            if isinstance(item, SubmissionConfirmation)
        ]
        for confirmation in confirmations:
            task = session.get(ServiceTask, confirmation.task_id)
            if not task or task.user_id != confirmation.user_id:
                continue
            if confirmation.status == "PENDING":
                review_hash = compute_review_hash(session, task)
                confirmation.declaration = _bind_declaration(confirmation.declaration, review_hash)
                _store_review_hash(session, task, review_hash)
            elif confirmation.status == "CONFIRMED":
                ensure_final_consent(session, task, confirmation)
            elif confirmation.status in {"SUPERSEDED", "REVOKED", "EXPIRED"}:
                invalidate_review_binding(session, task.id, task.user_id)
