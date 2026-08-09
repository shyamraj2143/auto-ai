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
from app.models.autoai_seva import SevaAgentProfile, SevaAssignment, SevaDeliverable, SevaNotification, SevaQualityReview, SevaRequirementRequest, SevaWorkOrder
from app.models.form_service import FormField, ServiceTask
from app.models.document import Document
from app.models.user import User
from app.services.autoai_seva_seed import ASSISTED_REQUEST_SERVICE_ID, ensure_autoai_seva_demo
from app.services.form_service_registry import ensure_service_registry
from app.services.notification_destination import with_notification_destination
from app.services.seva_assignment import assign_best_available_agent


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


def test_discovery_requires_explicit_service_confirmation_and_exposes_preflight(db: Session) -> None:
    applicant = add_user(db, "seva-discovery-user")
    current = {"user": applicant}
    client = client_for(db, current)
    before = db.query(ServiceTask).count()

    discovered = client.post(
        "/api/v1/form-services/seva-operations/discover",
        json={"query": "बिहार आय प्रमाण पत्र apply", "locale": "hi-IN"},
    )
    assert discovered.status_code == 200, discovered.text
    payload = discovered.json()
    assert payload["requires_confirmation"] is True
    assert payload["candidates"][0]["id"] == "bihar.income-certificate"
    assert payload["candidates"][0]["is_official_portal"] is False
    assert payload["candidates"][0]["documents"]
    assert db.query(ServiceTask).count() == before

    started = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={"query": "बिहार आय प्रमाण पत्र apply", "service_id": "bihar.income-certificate", "locale": "hi-IN", "timezone": "Asia/Kolkata", "client_request_id": "confirmed-discovery-1"},
    )
    assert started.status_code == 201, started.text
    assert started.json()["task"]["service_id"] == "bihar.income-certificate"
    assert db.query(ServiceTask).count() == before + 1


def test_server_draft_resumes_and_rejects_stale_versions(db: Session) -> None:
    applicant = add_user(db, "seva-draft-user")
    current = {"user": applicant}
    client = client_for(db, current)
    started = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={"query": "open a simple test form", "service_id": "autoai.safe-test-form", "locale": "en-IN", "timezone": "Asia/Kolkata", "client_request_id": "draft-start-1"},
    ).json()["task"]
    task_id = started["id"]
    saved = client.put(
        f"/api/v1/form-services/tasks/{task_id}/draft",
        json={"draft_version": 0, "schema_version": "2026.08", "values": {"applicant_name": "Asha Kumari", "email": "", "date_of_birth": "", "district": "Patna"}, "request_id": "draft-save-1"},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1
    assert saved.json()["values"]["district"] == "Patna"
    assert saved.json()["warnings"]
    assert db.query(FormField).filter_by(field_key="district").one().value_json == {"value": "Patna"}
    stale = client.put(
        f"/api/v1/form-services/tasks/{task_id}/draft",
        json={"draft_version": 0, "schema_version": "2026.08", "values": {"applicant_name": "Asha", "email": "", "date_of_birth": "", "district": "Gaya"}, "request_id": "draft-save-stale"},
    )
    assert stale.status_code == 409, stale.text


def test_quality_review_is_immutable_and_gates_submission(db: Session) -> None:
    applicant = add_user(db, "seva-quality-user")
    admin = add_user(db, "seva-quality-admin", admin=True)
    current = {"user": applicant}
    client = client_for(db, current)
    task = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={"query": "income certificate", "service_id": "bihar.income-certificate", "locale": "en-IN", "timezone": "Asia/Kolkata", "client_request_id": "quality-start-1"},
    ).json()["task"]
    work_order = client.post(
        f"/api/v1/form-services/seva-operations/tasks/{task['id']}/assistance",
        json={"purpose": "Prepare and review this application", "consent_accepted": True},
    ).json()
    assert work_order["quality_required"] is True
    current["user"] = admin
    client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order['id']}/claim")
    blocked = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order['id']}/status",
        json={"status": "READY_TO_SUBMIT", "note": "Ready", "progress_percent": 75},
    )
    assert blocked.status_code == 409
    review = client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order['id']}/quality-review")
    assert review.status_code == 201, review.text
    decided = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order['id']}/quality-review/decision",
        json={"approved": True, "reason": "Fields and documents verified"},
    )
    assert decided.status_code == 200, decided.text
    assert decided.json()["quality_status"] == "APPROVED"
    persisted = db.query(SevaQualityReview).one()
    assert persisted.status == "APPROVED" and persisted.snapshot_version >= 1


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
        json={"completed": True, "note": "OTP 123456 was entered on the official portal"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["requirements"][0]["status"] == "FULFILLED"
    stored = db.get(SevaRequirementRequest, requirement["id"])
    assert stored and stored.response_text is None
    assert "123456" not in (stored.user_note or "")

    current["user"] = employee
    requested_document = client.post(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements",
        json={"kind": "DOCUMENT", "label": "Upload supporting document", "instructions": "PDF or image", "required": True},
    )
    document_requirement = requested_document.json()["requirements"][-1]
    current["user"] = applicant
    requirement_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + (8).to_bytes(4, "big") + (8).to_bytes(4, "big") + b"\x00" * 32
    uploaded = client.post(
        f"/api/v1/form-services/seva-operations/tasks/{task_id}/assistance/requirements/{document_requirement['id']}/document",
        files={"file": ("support.png", BytesIO(requirement_png), "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    current["user"] = employee
    downloaded = client.get(
        f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements/{document_requirement['id']}/document/content"
    )
    assert downloaded.status_code == 200
    assert downloaded.content == requirement_png
    assert client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements/{requirement['id']}/review", json={"accepted": True}).status_code == 200
    assert client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{work_order_id}/requirements/{document_requirement['id']}/review", json={"accepted": True}).status_code == 200

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


def test_admin_created_agent_receives_least_loaded_assignment_and_private_notification(db: Session) -> None:
    applicant = add_user(db, "seva-auto-user")
    admin = add_user(db, "seva-auto-admin", admin=True)
    current = {"user": admin}
    client = client_for(db, current)

    created_agent = client.post(
        "/api/v1/form-services/seva-operations/admin/agents",
        json={"agent_id": "agent-101", "display_name": "Agent One", "password": "SecurePass123!", "capacity": 2},
    )
    assert created_agent.status_code == 201, created_agent.text
    agent = created_agent.json()
    assert agent["available_slots"] == 2
    logged_in = client.post(
        "/api/v1/form-services/seva-operations/agent/login",
        json={"agent_id": "agent-101", "password": "SecurePass123!"},
    )
    assert logged_in.status_code == 200, logged_in.text
    assert logged_in.json()["user"]["role"] == "seva_agent"

    current["user"] = applicant
    started = client.post(
        "/api/v1/form-services/seva-operations/start",
        json={
            "query": "Apply for a verified employee assisted local form",
            "timezone": "Asia/Kolkata",
            "locale": "en-IN",
            "client_request_id": "seva-auto-assignment-001",
        },
    )
    task_id = started.json()["task"]["id"]
    assistance = client.post(
        f"/api/v1/form-services/seva-operations/tasks/{task_id}/assistance",
        json={"purpose": "Complete and submit this application", "consent_accepted": True},
    )
    assert assistance.status_code == 201, assistance.text
    assert assistance.json()["status"] == "IN_PROGRESS"
    assert assistance.json()["assigned_employee"]["id"] == agent["user_id"]
    assert assistance.json()["queue_position"] is None

    notifications = client.get("/api/v1/form-services/seva-operations/notifications")
    assert notifications.status_code == 200
    assert notifications.json()["unread"] == 1
    assert notifications.json()["items"][0]["event_type"] == "AGENT_ASSIGNED"


def test_agent_password_lifecycle_rbac_progress_and_admin_reassignment(db: Session) -> None:
    applicant = add_user(db, "company-user")
    admin = add_user(db, "company-admin", admin=True)
    current = {"user": admin}
    client = client_for(db, current)
    first = client.post("/api/v1/form-services/seva-operations/admin/agents", json={"agent_id": "agt-2001", "display_name": "First Agent", "password": "Temporary123!", "capacity": 2}).json()
    second = client.post("/api/v1/form-services/seva-operations/admin/agents", json={"agent_id": "agt-2002", "display_name": "Second Agent", "password": "Temporary456!", "capacity": 2}).json()
    assert first["must_change_password"] is True
    duplicate = client.post("/api/v1/form-services/seva-operations/admin/agents", json={"agent_id": "agt-2001", "display_name": "Duplicate", "password": "Temporary789!", "capacity": 1})
    assert duplicate.status_code == 409
    invalid_login = client.post("/api/v1/form-services/seva-operations/agent/login", json={"agent_id": "agt-2001", "password": "wrong"})
    assert invalid_login.status_code == 401

    first_user = db.get(User, first["user_id"])
    current["user"] = first_user
    blocked_before_change = client.get("/api/v1/form-services/seva-operations/admin/work-orders")
    assert blocked_before_change.status_code == 403
    changed = client.post("/api/v1/form-services/seva-operations/agent/change-password", json={"current_password": "Temporary123!", "new_password": "PrivateAgent123!"})
    assert changed.status_code == 200
    assert db.get(SevaAgentProfile, first["id"]).must_change_password is False
    assert "PrivateAgent123!" not in first_user.hashed_password
    assert client.get("/api/v1/form-services/seva-operations/admin/agents").status_code == 403

    current["user"] = applicant
    started = client.post("/api/v1/form-services/seva-operations/start", json={"query": "Apply for a custom company workflow", "timezone": "Asia/Kolkata", "locale": "en-IN", "client_request_id": "company-case-start-001"})
    task_id = started.json()["task"]["id"]
    assistance = client.post(f"/api/v1/form-services/seva-operations/tasks/{task_id}/assistance", json={"purpose": "Process this case", "consent_accepted": True})
    case = assistance.json()
    assert case["case_id"].startswith("SEVA-")
    assigned_id = case["assigned_employee"]["id"]
    assigned_user = db.get(User, assigned_id)
    assigned_profile = db.scalar(select(SevaAgentProfile).where(SevaAgentProfile.user_id == assigned_id))
    current["user"] = assigned_user
    if assigned_profile.must_change_password:
        temporary = "Temporary456!" if assigned_id == second["user_id"] else "PrivateAgent123!"
        if assigned_id == second["user_id"]:
            assert client.post("/api/v1/form-services/seva-operations/agent/change-password", json={"current_password": temporary, "new_password": "PrivateAgent456!"}).status_code == 200
    progress = client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{case['id']}/status", json={"status": "IN_PROGRESS", "note": "Documents under review", "progress_percent": 55})
    assert progress.status_code == 200, progress.text
    assert progress.json()["work_progress"] == 55
    assert progress.json()["owner"]["email"] == applicant.email
    direct_complete = client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{case['id']}/status", json={"status": "COMPLETED", "progress_percent": 100})
    assert direct_complete.status_code == 422

    current["user"] = admin
    target = second if assigned_id != second["user_id"] else first
    reassigned = client.post(f"/api/v1/form-services/seva-operations/admin/work-orders/{case['id']}/reassign", json={"agent_profile_id": target["id"], "reason": "Workload balancing"})
    assert reassigned.status_code == 200, reassigned.text
    assert reassigned.json()["assigned_employee"]["id"] == target["user_id"]
    assert len(reassigned.json()["assignment_history"]) == 2
    assert db.scalar(select(SevaAssignment).where(SevaAssignment.work_order_id == case["id"], SevaAssignment.ended_at.is_not(None)))

    current["user"] = assigned_user
    assert client.get(f"/api/v1/form-services/seva-operations/admin/work-orders/{case['id']}").status_code == 409


def test_agent_capacity_queues_case_and_suspension_blocks_login(db: Session) -> None:
    admin = add_user(db, "capacity-admin", admin=True)
    first_user = add_user(db, "capacity-user-one")
    second_user = add_user(db, "capacity-user-two")
    current = {"user": admin}
    client = client_for(db, current)
    agent = client.post("/api/v1/form-services/seva-operations/admin/agents", json={"agent_id": "agt-cap", "display_name": "Capacity Agent", "password": "Capacity123!", "capacity": 1}).json()

    def create_case(owner: User, request_id: str) -> dict:
        current["user"] = owner
        task = client.post("/api/v1/form-services/seva-operations/start", json={"query": "Custom assisted request", "timezone": "Asia/Kolkata", "locale": "en-IN", "client_request_id": request_id}).json()["task"]
        return client.post(f"/api/v1/form-services/seva-operations/tasks/{task['id']}/assistance", json={"purpose": "Agent processing", "consent_accepted": True}).json()

    first_case = create_case(first_user, "capacity-case-start-001")
    second_case = create_case(second_user, "capacity-case-start-002")
    assert first_case["assigned_employee"]["id"] == agent["user_id"]
    assert second_case["status"] == "QUEUED" and second_case["queue_position"] == 1
    current["user"] = admin
    suspended = client.patch(f"/api/v1/form-services/seva-operations/admin/agents/{agent['id']}", json={"status": "SUSPENDED"})
    assert suspended.status_code == 200 and suspended.json()["status"] == "SUSPENDED"
    assert client.post("/api/v1/form-services/seva-operations/agent/login", json={"agent_id": "agt-cap", "password": "Capacity123!"}).status_code == 401


def test_seva_notification_mapping_and_assignment_deduplication(db: Session) -> None:
    applicant = add_user(db, "notify-user")
    admin = add_user(db, "notify-admin", admin=True)
    current = {"user": admin}
    client = client_for(db, current)
    agent = client.post("/api/v1/form-services/seva-operations/admin/agents", json={"agent_id": "notify-agent", "display_name": "Notification Agent", "password": "NotifyAgent123!", "capacity": 2}).json()
    current["user"] = applicant
    task = client.post("/api/v1/form-services/seva-operations/start", json={"query": "Notification test application", "timezone": "Asia/Kolkata", "locale": "en-IN", "client_request_id": "notify-start-001"}).json()["task"]
    case = client.post(f"/api/v1/form-services/seva-operations/tasks/{task['id']}/assistance", json={"purpose": "Verify notification delivery", "consent_accepted": True}).json()
    work_order = db.get(SevaWorkOrder, case["id"])
    before = len(list(db.scalars(select(SevaNotification).where(SevaNotification.work_order_id == case["id"]))))
    assert work_order.assigned_employee_id == agent["user_id"]
    assert assign_best_available_agent(db, work_order) is None
    db.commit()
    after = len(list(db.scalars(select(SevaNotification).where(SevaNotification.work_order_id == case["id"]))))
    assert after == before
    mapped = with_notification_destination({"type": "seva_case_update", "event_id": "evt-1", "case_route_id": task["id"]})
    assert mapped["destination"] == "SEVA_CASE"
    assert mapped["entity_id"] == task["id"]
