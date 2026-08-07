from __future__ import annotations

from io import BytesIO

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.routes import form_services
from app.db.base import Base
from app.db.session import get_db
from app.models.autoai_seva import SevaDeliverable, SevaRequirementRequest, SevaWorkOrder
from app.models.document import Document
from app.models.user import User
from app.services.autoai_seva_seed import ASSISTED_REQUEST_SERVICE_ID, ensure_autoai_seva_demo
from app.services.form_service_registry import ensure_service_registry


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


def add_user(db: Session, user_id: str, *, admin: bool = False) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name="AutoAI Employee" if admin else "Seva Applicant",
        username=user_id,
        hashed_password="unused",
        is_active=True,
        is_admin=admin,
        role="admin" if admin else "user",
    )
    db.add(user)
    db.commit()
    return user


def client_for(db: Session, current: dict[str, User]) -> TestClient:
    app = FastAPI()
    app.include_router(form_services.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: (yield db)
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    return TestClient(app)


def test_unknown_service_falls_back_to_structured_employee_assisted_form(db: Session) -> None:
    applicant = add_user(db, "seva-fallback-user")
    current = {"user": applicant}
    client = client_for(db, current)

    response = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={
            "query": "I need a college migration request that is not in the verified catalogue",
            "timezone": "Asia/Kolkata",
            "locale": "hi-IN",
            "client_request_id": "seva-fallback-start-001",
        },
    )
    assert response.status_code == 201, response.text
    payload = response.json()
    assert payload["fallback_to_employee"] is True
    assert payload["task"]["service_id"] == ASSISTED_REQUEST_SERVICE_ID
    assert payload["task"]["active_card"]["type"] == "information_request"


def test_employee_workflow_blocks_raw_otp_and_delivers_scoped_receipt(db: Session) -> None:
    applicant = add_user(db, "seva-workflow-user")
    employee = add_user(db, "seva-workflow-admin", admin=True)
    current = {"user": applicant}
    client = client_for(db, current)

    started = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={
            "query": "Apply for a custom local service through an AutoAI employee",
            "timezone": "Asia/Kolkata",
            "locale": "en-IN",
            "client_request_id": "seva-employee-start-001",
        },
    )
    assert started.status_code == 201, started.text
    task_id = started.json()["task"]["id"]

    assistance = client.post(
        f"/api/v1/form-services/seva-operations/tasks/{task_id}/assistance",
        json={
            "purpose": "Complete the application and provide the final receipt",
            "consent_accepted": True,
        },
    )
    assert assistance.status_code == 201, assistance.text
    work_order_id = assistance.json()["id"]
    assert assistance.json()["consent_scope"]["authentication_secrets_shared"] is False

    current["user"] = employee
    claimed = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/claim"
    )
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["assigned_employee"]["id"] == employee.id

    blocked = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements",
        json={
            "kind": "TEXT",
            "label": "Send your OTP code",
            "instructions": "Paste the OTP here",
            "required": True,
        },
    )
    assert blocked.status_code == 422
    assert "protected user action" in blocked.json()["detail"]

    protected = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements",
        json={
            "kind": "PROTECTED_ACTION",
            "label": "Complete OTP on the official portal",
            "instructions": "Enter the OTP directly on the official portal and only confirm completion here.",
            "required": True,
        },
    )
    assert protected.status_code == 201, protected.text
    requirement = protected.json()["requirements"][0]
    assert requirement["protected_action"] is True
    assert requirement["response_text"] is None

    current["user"] = applicant
    completed = client.post(
        f"/api/v1/form-services/seva-operations/tasks/{task_id}/assistance/requirements/{requirement['id']}/protected-action",
        json={"completed": True, "note": "Completed on the official portal"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["requirements"][0]["status"] == "FULFILLED"
    stored = db.get(SevaRequirementRequest, requirement["id"])
    assert stored and stored.response_text is None

    current["user"] = employee
    png = (
        b"\x89PNG\r\n\x1a\n"
        + b"\x00" * 8
        + (10).to_bytes(4, "big")
        + (12).to_bytes(4, "big")
        + b"\x00" * 32
    )
    delivered = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/deliverables",
        data={
            "label": "Application receipt",
            "note": "Submitted by the assigned AutoAI employee",
            "mark_completed": "true",
        },
        files={"file": ("receipt.png", BytesIO(png), "image/png")},
    )
    assert delivered.status_code == 201, delivered.text
    result = delivered.json()
    assert result["status"] == "COMPLETED"
    assert len(result["deliverables"]) == 1

    work_order = db.get(SevaWorkOrder, work_order_id)
    deliverable = db.scalar(select(SevaDeliverable).where(SevaDeliverable.work_order_id == work_order_id))
    document = db.get(Document, deliverable.document_id) if deliverable else None
    assert work_order and work_order.assigned_employee_id == employee.id
    assert deliverable and deliverable.verified_by_employee is True
    assert document and document.user_id == applicant.id
