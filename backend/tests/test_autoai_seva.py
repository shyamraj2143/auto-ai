from __future__ import annotations

from datetime import datetime
from io import BytesIO

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.datastructures import Headers, UploadFile

from app.db.base import Base
from app.models.document import Document
from app.models.form_service import (
    DocumentRequirement,
    PortalAdapterRecord,
    ServiceActionReceipt,
    ServiceDefinition,
    SubmissionAttempt,
    UserDataRequest,
)
from app.models.user import User
from app.schemas.form_service import ExecutionMode, TaskState
from app.services.autoai_seva_seed import DEMO_SERVICE_ID, ensure_autoai_seva_demo
from app.services.form_service_documents import inspect_and_store_upload
from app.services.form_service_registry import RegistryResolution, ensure_service_registry
from app.services.form_service_service import (
    approve_review,
    attach_document,
    confirm_submission,
    create_task,
    prepare_task,
    start_task,
    submit_fields,
    submit_task,
)


@pytest.fixture()
def db() -> Session:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, autoflush=False) as session:
        ensure_service_registry(session)
        ensure_autoai_seva_demo(session)
        yield session


def add_user(db: Session) -> User:
    user = User(
        id="autoai-seva-demo-user",
        email="seva-demo@example.test",
        name="Seva Demo User",
        username="seva-demo-user",
        hashed_password="unused",
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def test_seva_demo_seed_is_idempotent_and_never_configures_a_government_portal(db: Session) -> None:
    ensure_autoai_seva_demo(db)
    ensure_autoai_seva_demo(db)
    service = db.get(ServiceDefinition, DEMO_SERVICE_ID)
    adapters = list(
        db.scalars(
            select(PortalAdapterRecord).where(PortalAdapterRecord.service_id == DEMO_SERVICE_ID)
        )
    )
    assert service and service.category == "demonstration" and service.verified is True
    assert service.provider == "AutoAI Safe Government-Service Simulator"
    assert service.support_contact["label"] == "AutoAI Seva demo"
    assert service.support_contact["service_code"] == "AUTOAI_DEMO_BR_INCOME_CERTIFICATE"
    assert service.support_contact["legal_validity"] is False
    assert len(adapters) == 1
    assert adapters[0].adapter_type == "local_verified"
    assert adapters[0].configuration["simulation"] is True
    assert adapters[0].configuration["government_submission"] is False


@pytest.mark.asyncio
async def test_income_certificate_demo_reaches_verified_receipt(
    db: Session,
    tmp_path,
    monkeypatch,
) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "FORM_SERVICE_STORAGE_DIR", str(tmp_path))
    user = add_user(db)
    service = db.get(ServiceDefinition, DEMO_SERVICE_ID)
    adapter = db.scalar(
        select(PortalAdapterRecord).where(
            PortalAdapterRecord.service_id == DEMO_SERVICE_ID,
            PortalAdapterRecord.enabled.is_(True),
        )
    )
    assert service and adapter
    resolution = RegistryResolution(service=service, portal=None, adapter=adapter, confidence=1.0)
    task = create_task(
        db,
        user.id,
        resolution,
        chat_id=None,
        original_request="मुझे बिहार का आय प्रमाण पत्र बनवाना है — safe demo",
        execution_mode=ExecutionMode.EXECUTE_WITH_CONFIRMATION,
        timezone="Asia/Kolkata",
        locale="hi-IN",
        client_request_id="autoai-seva-demo-create",
    )
    start_task(
        db,
        task,
        expected_version=task.version,
        request_id="autoai-seva-demo-start",
    )

    supplied = {
        "applicant_name": "Asha Kumari",
        "father_name": "Ramesh Kumar",
        "date_of_birth": "2000-01-02",
        "mobile": "9999999999",
        "district": "Patna",
        "block": "Phulwari Sharif",
        "address": "Ward 10, Phulwari Sharif, Patna, Bihar",
        "occupation": "Student",
        "annual_income": 120000,
        "certificate_purpose": "Scholarship",
        "declaration": True,
    }
    requests = list(
        db.scalars(
            select(UserDataRequest)
            .where(UserDataRequest.task_id == task.id)
            .order_by(UserDataRequest.position)
        )
    )
    assert requests
    for index, request in enumerate(requests):
        submit_fields(
            db,
            task,
            data_request_id=request.id,
            values={field["key"]: supplied[field["key"]] for field in request.fields},
            expected_version=task.version,
            request_id=f"autoai-seva-demo-fields-{index}",
        )
    assert task.state == TaskState.COLLECTING_DOCUMENTS

    png = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00" * 8
        + (10).to_bytes(4, "big")
        + (12).to_bytes(4, "big")
        + b"\x00" * 32
    )
    requirements = list(
        db.scalars(
            select(DocumentRequirement)
            .where(DocumentRequirement.task_id == task.id)
            .order_by(DocumentRequirement.position)
        )
    )
    assert len(requirements) == 3
    for index, requirement in enumerate(requirements):
        upload = UploadFile(
            file=BytesIO(png),
            filename=f"seva-demo-document-{index}.png",
            headers=Headers({"content-type": "image/png"}),
        )
        inspected = await inspect_and_store_upload(
            upload,
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
                "private": True,
                "form_service_task_id": task.id,
                "demo": True,
                "created_at": datetime.utcnow().isoformat(),
            },
        )
        db.add(document)
        db.flush()
        attach_document(
            db,
            task,
            requirement=requirement,
            document=document,
            inspected=inspected,
            save_to_vault=False,
            expected_version=task.version,
            request_id=f"autoai-seva-demo-document-{index}",
        )
    assert task.state == TaskState.READY_TO_PREPARE

    prepare_task(
        db,
        task,
        expected_version=task.version,
        request_id="autoai-seva-demo-prepare",
    )
    assert task.state == TaskState.REVIEW_REQUIRED
    approve_review(
        db,
        task,
        expected_version=task.version,
        request_id="autoai-seva-demo-review",
    )
    confirmation = confirm_submission(
        db,
        task,
        expected_version=task.version,
        declaration_accepted=True,
        device_confirmation="confirmed",
        request_id="autoai-seva-demo-confirm",
    )
    submit_version = task.version
    submit_task(
        db,
        task,
        confirmation_id=confirmation.id,
        idempotency_key="autoai-seva-demo-submit-once",
        expected_version=submit_version,
        request_id="autoai-seva-demo-submit",
    )

    assert task.state == TaskState.COMPLETED_VERIFIED
    receipt = db.scalar(
        select(ServiceActionReceipt).where(ServiceActionReceipt.task_id == task.id)
    )
    assert receipt and receipt.verified_at is not None
    assert receipt.application_id and receipt.application_id.startswith("AUTOAI-TEST-")
    assert db.query(SubmissionAttempt).filter_by(task_id=task.id).count() == 1

    # A repeated idempotency key returns the same recorded outcome, never a duplicate submission.
    submit_task(
        db,
        task,
        confirmation_id=confirmation.id,
        idempotency_key="autoai-seva-demo-submit-once",
        expected_version=submit_version,
        request_id="autoai-seva-demo-submit-replay",
    )
    assert db.query(SubmissionAttempt).filter_by(task_id=task.id).count() == 1
    assert db.query(ServiceActionReceipt).filter_by(task_id=task.id).count() == 1
