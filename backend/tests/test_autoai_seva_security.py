from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.autoai_seva import ServiceFieldConflict
from app.models.document import Document
from app.models.form_service import (
    ConsentGrant,
    DocumentAnalysis,
    DocumentRequirement,
    FormDraft,
    PortalAdapterRecord,
    ServiceAuditEvent,
    ServiceDefinition,
    ServiceDocumentAsset,
    ServiceTask,
    SubmissionConfirmation,
    UserDataRequest,
    UserFieldResponse,
)
from app.models.user import User
from app.services.autoai_seva_conflicts import resolve_field_conflict, scan_task_conflicts
from app.services.autoai_seva_review import (
    FINAL_CONSENT_TYPE,
    compute_review_hash,
    public_state,
    validate_review_binding,
)
from app.services.form_service_adapters import (
    AdapterContext,
    AdapterKillSwitchActive,
    MockPortalAdapter,
    adapter_for,
)
from app.services.form_service_state import append_audit_event, sanitize_audit_details


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False) as session:
        yield session


def seed_reviewable_task(db: Session) -> tuple[User, ServiceTask, UserFieldResponse, PortalAdapterRecord]:
    user = User(
        id="seva-security-user",
        email="seva-security@example.test",
        name="Seva Security User",
        username="seva-security-user",
        hashed_password="unused",
        is_active=True,
    )
    service = ServiceDefinition(
        id="seva.security-test",
        name="Seva Security Test",
        provider="AutoAI",
        category="demonstration",
        verified=True,
        execution_modes=["EXECUTE_WITH_CONFIRMATION"],
        requirements=[{"key": "applicant_name", "label": "Applicant name", "required": True}],
        required_documents=[],
        support_contact={
            "service_code": "SEVA_SECURITY_TEST",
            "catalogue_version": "test-v1",
        },
    )
    adapter = PortalAdapterRecord(
        id="seva-security-adapter",
        service_id=service.id,
        adapter_key="autoai_seva_demo_local_verified",
        adapter_type="local_verified",
        enabled=True,
        capabilities=["prepare", "submit"],
        configuration={"adapter_version": "test-v1", "kill_switch_active": False},
    )
    task = ServiceTask(
        id="seva-security-task",
        user_id=user.id,
        service_id=service.id,
        adapter_id=adapter.id,
        client_request_id="seva-security-request",
        original_request="Create a safe test application",
        execution_mode="EXECUTE_WITH_CONFIRMATION",
        state="REVIEW_REQUIRED",
        current_card="form_review",
        progress_percent=70,
        version=7,
        expires_at=datetime.utcnow() + timedelta(hours=1),
    )
    request = UserDataRequest(
        id="seva-security-data-request",
        task_id=task.id,
        user_id=user.id,
        request_key="applicant",
        title="Applicant",
        fields=[{"key": "applicant_name", "label": "Applicant name", "required": True}],
        status="COMPLETED",
    )
    response = UserFieldResponse(
        task_id=task.id,
        user_id=user.id,
        request_id=request.id,
        field_key="applicant_name",
        value_json={"value": "Asha Kumari"},
        source="user",
        verified=True,
    )
    draft = FormDraft(
        task_id=task.id,
        user_id=user.id,
        status="VALIDATED",
        version=1,
        summary={"service": service.name},
        warnings=[],
        validated_at=datetime.utcnow(),
    )
    db.add_all([user, service, adapter, task, request, response, draft])
    db.commit()
    return user, task, response, adapter


def test_public_state_mapping_exposes_stable_product_states() -> None:
    assert public_state("SUBMISSION_CONFIRMATION_REQUIRED") == "AWAITING_FINAL_CONSENT"
    assert public_state("COMPLETED_VERIFIED") == "COMPLETED"
    assert public_state("UNKNOWN_FUTURE_STATE") == "UNKNOWN_FUTURE_STATE"


def test_review_hash_final_consent_and_edit_invalidation(db: Session) -> None:
    user, task, response, _ = seed_reviewable_task(db)
    first_hash = compute_review_hash(db, task)
    confirmation = SubmissionConfirmation(
        task_id=task.id,
        user_id=user.id,
        draft_version=1,
        declaration="I confirm this exact reviewed application.",
        status="PENDING",
        expires_at=datetime.utcnow() + timedelta(minutes=10),
    )
    db.add(confirmation)
    db.commit()
    assert first_hash in confirmation.declaration

    confirmation.status = "CONFIRMED"
    confirmation.confirmed_at = datetime.utcnow()
    db.commit()
    grant = db.scalar(
        select(ConsentGrant).where(
            ConsentGrant.task_id == task.id,
            ConsentGrant.purpose == FINAL_CONSENT_TYPE,
        )
    )
    assert grant and grant.status == "ACTIVE"
    valid, _ = validate_review_binding(db, task, confirmation)
    assert valid is True

    response.value_json = {"value": "Asha Rani"}
    response.version += 1
    db.commit()
    assert compute_review_hash(db, task) != first_hash
    assert confirmation.status == "SUPERSEDED"
    assert grant.status == "REVOKED"


def test_recursive_audit_redaction_masks_nested_secrets_and_identity_numbers(db: Session) -> None:
    _, task, _, _ = seed_reviewable_task(db)
    raw = {
        "outer": {
            "otp": "123456",
            "profile": {
                "aadhaar_number": "123412341234",
                "note": "PAN ABCDE1234F and account 123456789012 should not appear",
            },
        }
    }
    safe = sanitize_audit_details(raw)
    serialized = str(safe)
    assert "123456" not in serialized
    assert "123412341234" not in serialized
    assert "ABCDE1234F" not in serialized
    assert "123456789012" not in serialized
    append_audit_event(db, task, "SECURITY_TEST", raw, "security-test-request")
    db.commit()
    event = db.scalar(select(ServiceAuditEvent).where(ServiceAuditEvent.event_type == "SECURITY_TEST"))
    assert event and event.details == safe and len(event.event_hash) == 64


def test_adapter_kill_switch_blocks_before_execution(db: Session) -> None:
    _, _, _, adapter = seed_reviewable_task(db)
    adapter.configuration = {"kill_switch_active": True}
    db.commit()
    with pytest.raises(AdapterKillSwitchActive):
        adapter_for(adapter)


def test_mock_adapter_supports_transient_captcha_without_echoing_secret(db: Session) -> None:
    _, task, _, adapter = seed_reviewable_task(db)
    service = db.get(ServiceDefinition, task.service_id)
    context = AdapterContext(task, service, None, adapter, {}, [])
    result = MockPortalAdapter().consume_secret(context, "captcha", "Ab7K2")
    assert result == {
        "accepted": True,
        "session_status": "VERIFIED",
        "persisted_secret": False,
    }
    assert "Ab7K2" not in str(result)


def test_document_conflict_is_owner_scoped_encrypted_and_resolvable(db: Session) -> None:
    user, task, response, _ = seed_reviewable_task(db)
    task.state = "COLLECTING_DOCUMENTS"
    requirement = DocumentRequirement(
        id="seva-conflict-requirement",
        task_id=task.id,
        user_id=user.id,
        requirement_key="identity",
        label="Identity proof",
        accepted_mime_types=["image/png"],
        max_bytes=1024,
        required=True,
        status="ANALYSIS_REVIEW",
    )
    document = Document(
        id="seva-conflict-document",
        user_id=user.id,
        filename="identity.png",
        content_type="image/png",
        file_size=64,
        file_path="/tmp/nonexistent-seva-conflict.png",
        extracted_text="",
        document_metadata={"private": True},
    )
    asset = ServiceDocumentAsset(
        id="seva-conflict-asset",
        task_id=task.id,
        user_id=user.id,
        requirement_id=requirement.id,
        document_id=document.id,
        sha256="a" * 64,
        validation_status="VALID",
        detected_type="image/png",
        warnings=["Applicant name differs"],
    )
    analysis = DocumentAnalysis(
        asset_id=asset.id,
        user_id=user.id,
        status="REVIEW_REQUIRED",
        extracted_fields={
            "applicant_name": {"value": "Asha Rani", "confidence": 0.94}
        },
    )
    db.add_all([requirement, document, asset, analysis])
    db.commit()

    conflicts = scan_task_conflicts(db, task, request_id="conflict-scan-request")
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert isinstance(conflict, ServiceFieldConflict)
    assert conflict.user_id == user.id
    assert "Asha Rani" not in str(conflict.candidate_summary)
    assert conflict.encrypted_candidate_values and "Asha Rani" not in conflict.encrypted_candidate_values

    resolve_field_conflict(
        db,
        task,
        conflict,
        selected_source="document",
        request_id="conflict-resolve-request",
    )
    db.refresh(response)
    assert response.value_json["value"] == "Asha Rani"
    assert response.value_json["source_document_id"] == asset.id
    assert response.value_json["user_confirmed"] is True
    assert conflict.resolution_state == "RESOLVED"
