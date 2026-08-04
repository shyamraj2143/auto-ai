from io import BytesIO
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.datastructures import Headers, UploadFile

from app.api.deps import get_current_user
from app.api.routes import form_services
from app.db.base import Base
from app.db.session import get_db
from app.models.document import Document
from app.models.form_service import DocumentAnalysis, DocumentRequirement, HumanHandoff, PortalSession, ServiceActionReceipt, ServiceAuditEvent, ServiceDocumentAsset, ServiceSecureChallenge, ServiceTask, SubmissionAttempt, TaskStateTransition, UserDataRequest
from app.models.message import Message
from app.models.trust_hub import HubEmergencyPause, TrustActionRequest
from app.models.user import User
from app.schemas.form_service import ExecutionMode, TaskState
from app.services.form_service_documents import inspect_and_store_upload
from app.services.form_service_registry import RegistrySecurityError, ensure_service_registry, normalized_https_origin, resolve_service
from app.services.form_service_service import analyze_document_ocr, approve_review, attach_document, build_task_view, complete_human_action, confirm_submission, consume_secure_response, create_handoff, create_portal_session, create_task, decide_document_analysis, get_owned_task, prepare_task, reopen_documents, report_portal_outcome, request_secure_challenge, retry_task, revoke_consent, revoke_handoff, start_task, submit_fields, submit_task
from app.services.form_service_state import InvalidTaskTransition, transition_task
from app.services.form_service_tools import ToolPolicyError, ToolProposal, validate_tool_proposal


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False) as session:
        ensure_service_registry(session)
        yield session


def add_user(db: Session, user_id: str) -> User:
    user = User(id=user_id, email=f"{user_id}@example.test", name=f"User {user_id}", username=user_id, hashed_password="unused", is_active=True)
    db.add(user)
    db.commit()
    return user


def local_task(db: Session, user: User, request_id: str = "service-create-request-1") -> ServiceTask:
    resolution = resolve_service(db, "Open a simple test form")
    assert resolution
    return create_task(db, user.id, resolution, chat_id=None, original_request="Open a simple test form", execution_mode=ExecutionMode.EXECUTE_WITH_CONFIRMATION, timezone="Asia/Kolkata", locale="en-IN", client_request_id=request_id)


def ready_local_task(db: Session, user: User) -> ServiceTask:
    task = local_task(db, user)
    start_task(db, task, expected_version=task.version, request_id="service-start-request-1")
    data_request = db.scalar(select(UserDataRequest).where(UserDataRequest.task_id == task.id))
    assert data_request
    submit_fields(
        db,
        task,
        data_request_id=data_request.id,
        values={"applicant_name": "Asha Kumari", "email": "asha@example.test", "date_of_birth": "2000-01-02", "district": "Patna"},
        expected_version=task.version,
        request_id="service-fields-request-1",
    )
    prepare_task(db, task, expected_version=task.version, request_id="service-prepare-request-1")
    return task


def test_simple_form_requires_confirmation_and_returns_verified_idempotent_receipt(db: Session) -> None:
    user = add_user(db, "form-owner")
    task = ready_local_task(db, user)
    assert task.state == TaskState.REVIEW_REQUIRED
    approve_review(db, task, expected_version=task.version, request_id="service-review-request-1")
    confirmation = confirm_submission(db, task, expected_version=task.version, declaration_accepted=True, device_confirmation="unavailable", request_id="service-confirm-request-1")
    assert task.state == TaskState.SUBMISSION_CONFIRMATION_REQUIRED
    version_before_submit = task.version
    submit_task(db, task, confirmation_id=confirmation.id, idempotency_key="service-submit-idempotency-1", expected_version=version_before_submit, request_id="service-submit-request-1")
    assert task.state == TaskState.COMPLETED_VERIFIED
    receipt = db.scalar(select(ServiceActionReceipt).where(ServiceActionReceipt.task_id == task.id))
    assert receipt and receipt.application_id.startswith("AUTOAI-TEST-") and receipt.verified_at
    submit_task(db, task, confirmation_id=confirmation.id, idempotency_key="service-submit-idempotency-1", expected_version=version_before_submit, request_id="service-submit-replay-1")
    assert db.query(SubmissionAttempt).filter_by(task_id=task.id).count() == 1
    assert db.query(ServiceActionReceipt).filter_by(task_id=task.id).count() == 1


def test_audit_events_are_append_only(db: Session) -> None:
    task = local_task(db, add_user(db, "form-audit"), "service-audit-create")
    event = db.scalar(select(ServiceAuditEvent).where(ServiceAuditEvent.task_id == task.id))
    assert event
    event.details = {"tampered": True}
    with pytest.raises(RuntimeError, match="append-only"):
        db.commit()
    db.rollback()


def test_submission_cannot_run_before_review_confirmation(db: Session) -> None:
    user = add_user(db, "form-no-confirm")
    task = ready_local_task(db, user)
    approve_review(db, task, expected_version=task.version, request_id="service-review-no-confirm")
    with pytest.raises(Exception) as error:
        submit_task(db, task, confirmation_id="missing", idempotency_key="service-submit-no-confirm", expected_version=task.version, request_id="service-submit-no-confirm")
    assert "confirmation" in str(error.value).lower()
    assert db.query(SubmissionAttempt).filter_by(task_id=task.id).count() == 0


def test_task_persists_and_cross_user_isolation_returns_not_found(db: Session) -> None:
    owner = add_user(db, "form-first")
    other = add_user(db, "form-second")
    task = local_task(db, owner, "service-cross-user-request")
    task_id = task.id
    db.expire_all()
    assert get_owned_task(db, owner.id, task_id).state == TaskState.CREATED
    with pytest.raises(Exception) as error:
        get_owned_task(db, other.id, task_id)
    assert getattr(error.value, "status_code", None) == 404


def test_api_enforces_ownership_and_refresh_returns_latest_card(db: Session) -> None:
    owner = add_user(db, "form-api-owner")
    other = add_user(db, "form-api-other")
    current = {"user": owner}
    app = FastAPI()
    app.include_router(form_services.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: (yield db)
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    client = TestClient(app)
    created = client.post("/api/v1/form-services/interpret", json={"message": "Fill a test form", "timezone": "Asia/Kolkata", "locale": "en-IN", "client_request_id": "service-api-create-1"})
    assert created.status_code == 200 and created.json()["handled"] is True
    task_id = created.json()["task"]["id"]
    assert client.get(f"/api/v1/form-services/tasks/{task_id}").json()["active_card"]["type"] == "information_request"
    current["user"] = other
    assert client.get(f"/api/v1/form-services/tasks/{task_id}").status_code == 404


def test_ephemeral_otp_is_never_persisted_or_rendered_in_chat(db: Session) -> None:
    user = add_user(db, "form-secret")
    task = ready_local_task(db, user)
    challenge = request_secure_challenge(db, task, kind="otp", expected_version=task.version, request_id="service-challenge-create")
    raw = "654321"
    consume_secure_response(db, task, challenge, secret=raw, request_id="service-challenge-consume")
    db.expire_all()
    stored = db.get(ServiceSecureChallenge, challenge.id)
    assert stored and stored.status == "CONSUMED"
    assert raw not in str(stored.__dict__)
    assert all(raw not in message.content and raw not in str(message.message_metadata) for message in db.scalars(select(Message).where(Message.chat_id == task.chat_id)))


def test_otp_test_form_runs_from_chat_to_review_without_persisting_code(db: Session) -> None:
    user = add_user(db, "form-otp-flow")
    resolution = resolve_service(db, "Open an OTP test form")
    assert resolution and resolution.service.id == "autoai.safe-test-otp-form"
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Open an OTP test form", execution_mode=ExecutionMode.EXECUTE_WITH_CONFIRMATION, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-otp-create")
    start_task(db, task, expected_version=task.version, request_id="service-otp-start")
    data_request = db.scalar(select(UserDataRequest).where(UserDataRequest.task_id == task.id))
    assert data_request
    submit_fields(db, task, data_request_id=data_request.id, values={"applicant_name": "Asha Kumari", "phone": "9999999999"}, expected_version=task.version, request_id="service-otp-fields")
    prepare_task(db, task, expected_version=task.version, request_id="service-otp-prepare")
    assert task.state == TaskState.AWAITING_AUTHENTICATION
    challenge = db.scalar(select(ServiceSecureChallenge).where(ServiceSecureChallenge.task_id == task.id, ServiceSecureChallenge.status == "PENDING"))
    assert challenge and build_task_view(db, task).active_card.type.value == "secure_input_request"
    raw = "482913"
    consume_secure_response(db, task, challenge, secret=raw, request_id="service-otp-consume")
    assert task.state == TaskState.REVIEW_REQUIRED
    assert raw not in str(db.get(ServiceSecureChallenge, challenge.id).__dict__)
    assert all(raw not in message.content and raw not in str(message.message_metadata) for message in db.scalars(select(Message).where(Message.chat_id == task.chat_id)))


def test_timeout_demonstration_creates_unverified_receipt_and_recovery_not_success(db: Session) -> None:
    user = add_user(db, "form-unverified-flow")
    resolution = resolve_service(db, "Open an unverified test form")
    assert resolution and resolution.service.id == "autoai.safe-test-unverified-form"
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Open an unverified test form", execution_mode=ExecutionMode.EXECUTE_WITH_CONFIRMATION, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-unverified-create")
    start_task(db, task, expected_version=task.version, request_id="service-unverified-start")
    request = db.scalar(select(UserDataRequest).where(UserDataRequest.task_id == task.id))
    assert request
    submit_fields(db, task, data_request_id=request.id, values={"applicant_name": "Asha Kumari", "email": "asha@example.test"}, expected_version=task.version, request_id="service-unverified-fields")
    prepare_task(db, task, expected_version=task.version, request_id="service-unverified-prepare")
    approve_review(db, task, expected_version=task.version, request_id="service-unverified-review")
    confirmation = confirm_submission(db, task, expected_version=task.version, declaration_accepted=True, device_confirmation="unavailable", request_id="service-unverified-confirm")
    submit_task(db, task, confirmation_id=confirmation.id, idempotency_key="service-unverified-submit", expected_version=task.version, request_id="service-unverified-submit")
    receipt = db.scalar(select(ServiceActionReceipt).where(ServiceActionReceipt.task_id == task.id))
    assert task.state == TaskState.SUBMITTED_UNVERIFIED and receipt and receipt.verified_at is None
    assert build_task_view(db, task).active_card.type.value == "action_receipt"
    retry_task(db, task, expected_version=task.version, request_id="service-unverified-verify")
    assert task.state == TaskState.SUBMITTED_UNVERIFIED


def test_illegal_state_transition_is_rejected_and_every_legal_change_is_recorded(db: Session) -> None:
    user = add_user(db, "form-transition")
    task = local_task(db, user, "service-transition-create")
    with pytest.raises(InvalidTaskTransition):
        transition_task(db, task, TaskState.COMPLETED_VERIFIED, actor="system", source="test", reason="invalid", request_id="service-transition-invalid")
    start_task(db, task, expected_version=task.version, request_id="service-transition-start")
    transitions = list(db.scalars(select(TaskStateTransition).where(TaskStateTransition.task_id == task.id)))
    assert [item.new_state for item in transitions[:4]] == ["INTENT_CONFIRMED", "SERVICE_DISCOVERY", "REQUIREMENTS_READY", "COLLECTING_INFORMATION"]


def test_unverified_or_lookalike_portal_is_blocked() -> None:
    assert normalized_https_origin("https://serviceonline.bihar.gov.in/path") == "https://serviceonline.bihar.gov.in"
    with pytest.raises(RegistrySecurityError):
        normalized_https_origin("http://serviceonline.bihar.gov.in")
    with pytest.raises(RegistrySecurityError):
        normalized_https_origin("https://127.0.0.1/private")
    with pytest.raises(RegistrySecurityError):
        normalized_https_origin("https://bit.ly/official")


@pytest.mark.asyncio
async def test_active_pdf_payload_is_rejected_without_parser_crash(tmp_path, monkeypatch) -> None:
    from app.core.config import settings
    monkeypatch.setattr(settings, "FORM_SERVICE_STORAGE_DIR", str(tmp_path))
    malicious = UploadFile(file=BytesIO(b"%PDF-1.4\n1 0 obj<</OpenAction 2 0 R /JavaScript(boom)>>endobj\n%%EOF"), filename="certificate.pdf", headers=Headers({"content-type": "application/pdf"}))
    with pytest.raises(Exception) as error:
        await inspect_and_store_upload(malicious, "pdf-owner", accepted=["application/pdf"], max_bytes=2 * 1024 * 1024)
    assert getattr(error.value, "status_code", None) == 422
    assert not list(tmp_path.rglob("*"))


@pytest.mark.asyncio
async def test_document_workflow_validates_magic_size_and_reaches_draft_ready(db: Session, tmp_path, monkeypatch) -> None:
    from app.core.config import settings
    monkeypatch.setattr(settings, "FORM_SERVICE_STORAGE_DIR", str(tmp_path))
    user = add_user(db, "form-documents")
    resolution = resolve_service(db, "Fill my scholarship form")
    assert resolution
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Fill my scholarship form", execution_mode=ExecutionMode.ASSIST, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-doc-create")
    start_task(db, task, expected_version=task.version, request_id="service-doc-start")
    requests = list(db.scalars(select(UserDataRequest).where(UserDataRequest.task_id == task.id).order_by(UserDataRequest.position)))
    supplied = {"student_name": "Asha Kumari", "email": "asha@example.test", "phone": "9999999999", "course": "BSc", "annual_income": 120000}
    for index, request in enumerate(requests):
        submit_fields(db, task, data_request_id=request.id, values={field["key"]: supplied[field["key"]] for field in request.fields}, expected_version=task.version, request_id=f"service-doc-fields-{index}")
    assert task.state == TaskState.COLLECTING_DOCUMENTS
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + (10).to_bytes(4, "big") + (12).to_bytes(4, "big") + b"\x00" * 32
    requirements = list(db.scalars(select(DocumentRequirement).where(DocumentRequirement.task_id == task.id).order_by(DocumentRequirement.position)))
    for index, requirement in enumerate(requirements):
        upload = UploadFile(file=BytesIO(png), filename=f"document-{index}.png", headers=Headers({"content-type": "image/png"}))
        inspected = await inspect_and_store_upload(upload, user.id, accepted=requirement.accepted_mime_types, max_bytes=requirement.max_bytes)
        document = Document(user_id=user.id, chat_id=task.chat_id, filename=inspected.filename, content_type=inspected.content_type, file_size=inspected.size, file_path=inspected.path, extracted_text="", document_metadata={"private": True})
        db.add(document)
        db.flush()
        attach_document(db, task, requirement=requirement, document=document, inspected=inspected, save_to_vault=False, expected_version=task.version, request_id=f"service-doc-upload-{index}")
    assert task.state == TaskState.READY_TO_PREPARE
    assert len(build_task_view(db, task).active_card.data["steps"]) == 3


def test_document_text_candidates_require_explicit_review_and_raw_text_is_not_persisted(db: Session) -> None:
    user = add_user(db, "form-document-analysis")
    resolution = resolve_service(db, "Fill my scholarship form")
    assert resolution
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Fill my scholarship form", execution_mode=ExecutionMode.ASSIST, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-analysis-create")
    start_task(db, task, expected_version=task.version, request_id="service-analysis-start")
    supplied = {"student_name": "Asha Kumari", "email": "asha@example.test", "phone": "9999999999", "course": "BSc", "annual_income": 120000}
    for index, request in enumerate(list(db.scalars(select(UserDataRequest).where(UserDataRequest.task_id == task.id).order_by(UserDataRequest.position)))):
        submit_fields(db, task, data_request_id=request.id, values={field["key"]: supplied[field["key"]] for field in request.fields}, expected_version=task.version, request_id=f"service-analysis-fields-{index}")
    requirements = list(db.scalars(select(DocumentRequirement).where(DocumentRequirement.task_id == task.id).order_by(DocumentRequirement.position)))
    reviewed_asset = None
    for index, requirement in enumerate(requirements):
        extracted = "Student name: Asha Kumari\nPercentage: 80.5" if index == 0 else ""
        inspected = SimpleNamespace(sha256=f"{index + 1:064x}", content_type="image/png", extracted_text=extracted, page_count=None, dimensions={"width": 10, "height": 12}, size=80, scanner_result={"status": "CLEAN"})
        document = Document(user_id=user.id, chat_id=task.chat_id, filename=f"document-{index}.png", content_type="image/png", file_size=80, file_path=f"private/document-{index}.png", extracted_text="", document_metadata={"private": True})
        db.add(document)
        db.flush()
        attached = attach_document(db, task, requirement=requirement, document=document, inspected=inspected, save_to_vault=False, expected_version=task.version, request_id=f"service-analysis-document-{index}")
        if index == 0:
            reviewed_asset = attached
    assert task.state == TaskState.COLLECTING_DOCUMENTS and reviewed_asset
    analysis = db.scalar(select(DocumentAnalysis).where(DocumentAnalysis.asset_id == reviewed_asset.id))
    assert analysis and analysis.status == "REVIEW_REQUIRED" and set(analysis.extracted_fields) == {"student_name", "percentage"}
    assert db.get(Document, reviewed_asset.document_id).extracted_text == ""
    decide_document_analysis(db, task, reviewed_asset, analysis, accepted=True, accepted_fields=["student_name", "percentage"], expected_version=task.version, request_id="service-analysis-accept")
    assert task.state == TaskState.READY_TO_PREPARE
    assert all(item["accepted"] is True for item in analysis.extracted_fields.values())


def test_image_ocr_requires_consent_uses_gateway_and_retains_only_candidates(db: Session, tmp_path, monkeypatch) -> None:
    from app.core.config import settings
    monkeypatch.setattr(settings, "FORM_SERVICE_STORAGE_DIR", str(tmp_path))
    monkeypatch.setattr("app.services.groq_service.groq_service.analyze_image", lambda *_args, **_kwargs: "Applicant name: Asha Kumari\nDate of birth: 2000-01-02")
    user = add_user(db, "form-cloud-ocr")
    resolution = resolve_service(db, "Open a simple test form")
    assert resolution
    resolution.service.required_documents = [{"key": "identity", "label": "Identity proof", "accepted": ["image/png"], "max_bytes": 2097152}]
    db.commit()
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Open a simple test form", execution_mode=ExecutionMode.EXECUTE_WITH_CONFIRMATION, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-cloud-ocr-create")
    start_task(db, task, expected_version=task.version, request_id="service-cloud-ocr-start")
    request = db.scalar(select(UserDataRequest).where(UserDataRequest.task_id == task.id))
    assert request
    submit_fields(db, task, data_request_id=request.id, values={"applicant_name": "Asha Kumari", "email": "asha@example.test", "date_of_birth": "2000-01-02", "district": "Patna"}, expected_version=task.version, request_id="service-cloud-ocr-fields")
    requirement = db.scalar(select(DocumentRequirement).where(DocumentRequirement.task_id == task.id))
    assert requirement
    path = tmp_path / user.id / "identity.png"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 72)
    inspected = SimpleNamespace(sha256="f" * 64, content_type="image/png", extracted_text="", page_count=None, dimensions={"width": 10, "height": 12}, size=80, scanner_result={"status": "CLEAN"})
    document = Document(user_id=user.id, chat_id=task.chat_id, filename="identity.png", content_type="image/png", file_size=80, file_path=str(path), extracted_text="", document_metadata={"private": True})
    db.add(document)
    db.flush()
    asset = attach_document(db, task, requirement=requirement, document=document, inspected=inspected, save_to_vault=False, expected_version=task.version, request_id="service-cloud-ocr-upload")
    reopen_documents(db, task, expected_version=task.version, request_id="service-cloud-ocr-reopen")
    analysis = db.scalar(select(DocumentAnalysis).where(DocumentAnalysis.asset_id == asset.id))
    assert analysis
    with pytest.raises(Exception) as error:
        analyze_document_ocr(db, task, asset, document, analysis, cloud_processing_accepted=False, expected_version=task.version, request_id="service-cloud-ocr-denied")
    assert getattr(error.value, "status_code", None) == 422
    analyze_document_ocr(db, task, asset, document, analysis, cloud_processing_accepted=True, expected_version=task.version, request_id="service-cloud-ocr-run")
    assert analysis.status == "REVIEW_REQUIRED" and set(analysis.extracted_fields) == {"applicant_name", "date_of_birth"}
    assert document.extracted_text == "" and task.state == TaskState.COLLECTING_DOCUMENTS
    gateway = db.scalar(select(TrustActionRequest).where(TrustActionRequest.user_id == user.id, TrustActionRequest.action_type == "form.document.ocr"))
    assert gateway and gateway.status == "EXECUTED"


def test_service_resolver_supports_hindi_hinglish_and_guided_mode(db: Session) -> None:
    add_user(db, "form-language")
    scholarship = resolve_service(db, "meri scholarship ka form apply kar do")
    income = resolve_service(db, "मेरा आय प्रमाण पत्र apply कर दो")
    assert scholarship and scholarship.service.id == "india.national-scholarship" and scholarship.adapter.adapter_type == "guided_browser"
    assert income and income.service.id == "bihar.income-certificate" and income.portal and income.portal.verified


def test_typed_tool_policy_rejects_invented_tools_cross_user_and_secret_arguments() -> None:
    with pytest.raises(ToolPolicyError):
        validate_tool_proposal(ToolProposal(tool="root_shell", task_id="1" * 36, arguments={}, idempotency_key="tool-request-1"), authenticated_user_id="owner", task_user_id="owner", task_state="CREATED")
    with pytest.raises(ToolPolicyError):
        validate_tool_proposal(ToolProposal(tool="prepare_form", task_id="1" * 36, arguments={}, idempotency_key="tool-request-2"), authenticated_user_id="other", task_user_id="owner", task_state="READY_TO_PREPARE")
    with pytest.raises(ToolPolicyError):
        validate_tool_proposal(ToolProposal(tool="request_secure_input", task_id="1" * 36, arguments={"otp": "123456"}, idempotency_key="tool-request-3"), authenticated_user_id="owner", task_user_id="owner", task_state="AWAITING_AUTHENTICATION")


def test_revoked_consent_and_emergency_pause_block_submission(db: Session) -> None:
    user = add_user(db, "form-policy")
    task = ready_local_task(db, user)
    approve_review(db, task, expected_version=task.version, request_id="service-policy-review")
    confirmation = confirm_submission(db, task, expected_version=task.version, declaration_accepted=True, device_confirmation="unavailable", request_id="service-policy-confirm")
    db.add(HubEmergencyPause(user_id=user.id, active=True, reason="User paused AI actions"))
    db.commit()
    submit_task(db, task, confirmation_id=confirmation.id, idempotency_key="service-policy-submit", expected_version=task.version, request_id="service-policy-submit")
    assert task.state == TaskState.FAILED_RECOVERABLE
    assert db.query(ServiceActionReceipt).filter_by(task_id=task.id).count() == 0
    assert db.query(SubmissionAttempt).filter_by(task_id=task.id, status="BLOCKED").count() == 1

    second = ready_local_task(db, add_user(db, "form-consent"))
    revoke_consent(db, second, expected_version=second.version, request_id="service-consent-revoke")
    assert second.state == TaskState.PAUSED


def test_guided_portal_open_passes_shared_gateway_and_never_claims_submission(db: Session) -> None:
    user = add_user(db, "form-guided")
    resolution = resolve_service(db, "Book my doctor appointment")
    assert resolution
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Book my doctor appointment", execution_mode=ExecutionMode.ASSIST, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-guided-create")
    start_task(db, task, expected_version=task.version, request_id="service-guided-start")
    supplied = {"patient_name": "Asha Kumari", "phone": "9999999999", "hospital": "AIIMS", "department": "General Medicine", "preferred_date": "2030-01-01"}
    for index, request in enumerate(list(db.scalars(select(UserDataRequest).where(UserDataRequest.task_id == task.id).order_by(UserDataRequest.position)))):
        submit_fields(db, task, data_request_id=request.id, values={field["key"]: supplied[field["key"]] for field in request.fields}, expected_version=task.version, request_id=f"service-guided-fields-{index}")
    prepare_task(db, task, expected_version=task.version, request_id="service-guided-prepare")
    approve_review(db, task, expected_version=task.version, request_id="service-guided-review")
    confirm_submission(db, task, expected_version=task.version, declaration_accepted=True, device_confirmation="unavailable", request_id="service-guided-confirm")
    session = create_portal_session(db, task, expected_version=task.version, request_id="service-guided-open")
    assert session.mode == "GUIDED_ONLY" and db.query(PortalSession).filter_by(task_id=task.id).count() == 1
    gateway = db.scalar(select(TrustActionRequest).where(TrustActionRequest.user_id == user.id, TrustActionRequest.action_type == "form.portal.open"))
    assert gateway and gateway.status == "EXECUTED"
    view = build_task_view(db, task)
    assert view.state == TaskState.AWAITING_AUTHENTICATION
    assert view.active_card.data["secure_channel_supported"] is False
    assert db.query(ServiceActionReceipt).filter_by(task_id=task.id).count() == 0
    session.expires_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    with pytest.raises(Exception) as expired_error:
        complete_human_action(db, task, action="otp", completed=True, expected_version=task.version, request_id="service-guided-expired-session")
    assert getattr(expired_error.value, "status_code", None) == 410 and session.status == "EXPIRED"


def test_guided_user_report_stays_unverified_and_handoff_shares_only_approved_data(db: Session) -> None:
    user = add_user(db, "form-guided-outcome")
    resolution = resolve_service(db, "Book my doctor appointment")
    assert resolution
    task = create_task(db, user.id, resolution, chat_id=None, original_request="Book my doctor appointment", execution_mode=ExecutionMode.ASSIST, timezone="Asia/Kolkata", locale="en-IN", client_request_id="service-outcome-create")
    start_task(db, task, expected_version=task.version, request_id="service-outcome-start")
    supplied = {"patient_name": "Asha Kumari", "phone": "9999999999", "hospital": "AIIMS", "department": "General Medicine", "preferred_date": "2030-01-01"}
    for index, request in enumerate(list(db.scalars(select(UserDataRequest).where(UserDataRequest.task_id == task.id).order_by(UserDataRequest.position)))):
        submit_fields(db, task, data_request_id=request.id, values={field["key"]: supplied[field["key"]] for field in request.fields}, expected_version=task.version, request_id=f"service-outcome-fields-{index}")
    prepare_task(db, task, expected_version=task.version, request_id="service-outcome-prepare")
    approve_review(db, task, expected_version=task.version, request_id="service-outcome-review")
    confirm_submission(db, task, expected_version=task.version, declaration_accepted=True, device_confirmation="unavailable", request_id="service-outcome-confirm")
    create_portal_session(db, task, expected_version=task.version, request_id="service-outcome-open")
    with pytest.raises(Exception) as human_error:
        complete_human_action(db, task, action="captcha", completed=False, expected_version=task.version, request_id="service-outcome-captcha-incomplete")
    assert getattr(human_error.value, "status_code", None) == 422 and task.state == TaskState.AWAITING_AUTHENTICATION
    complete_human_action(db, task, action="otp", completed=True, expected_version=task.version, request_id="service-outcome-auth")
    handoff = create_handoff(db, task, approved_field_keys=["patient_name"], approved_document_ids=[], purpose="Help with guided completion", expected_version=task.version, request_id="service-outcome-handoff")
    assert handoff.approved_field_keys == ["patient_name"] and handoff.agent_identity["verified"] is False
    assert build_task_view(db, task).active_card.data["active_handoffs"][0]["id"] == handoff.id
    revoke_handoff(db, task, handoff.id, expected_version=task.version, request_id="service-outcome-handoff-revoke")
    assert db.get(HumanHandoff, handoff.id).status == "REVOKED"
    assert build_task_view(db, task).active_card.data["active_handoffs"] == []
    report_portal_outcome(db, task, application_id="USER-REPORTED-1", transaction_id=None, user_reported_status="submitted", idempotency_key="service-outcome-submit", expected_version=task.version, request_id="service-outcome-submit")
    receipt = db.scalar(select(ServiceActionReceipt).where(ServiceActionReceipt.task_id == task.id))
    assert receipt and receipt.status == "submitted but unverified" and receipt.verified_at is None
    retry_task(db, task, expected_version=task.version, request_id="service-outcome-retry")
    assert task.state == TaskState.SUBMITTED_UNVERIFIED
