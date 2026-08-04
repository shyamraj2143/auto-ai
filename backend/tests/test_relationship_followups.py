from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.routes import relationship_followups
from app.db.base import Base
from app.db.session import get_db
from app.core.rate_limit import InMemoryRateLimitMiddleware
from app.main import RelationshipPayloadLimitMiddleware, RequestIdMiddleware
from app.models.call import UserDevice
from app.models.relationship_followup import (
    RelationshipAuditEvent,
    RelationshipContact,
    RelationshipDeliveryAttempt,
    RelationshipFollowupEvent,
    RelationshipInteraction,
    RelationshipNotificationPreference,
)
from app.models.user import User
from app.schemas.relationship_followup import ContactCreate
from app.services.device_token_security import encrypt_token
from app.services.firebase_notifications import FcmSendResult
from app.services.relationship_followup_scheduler import claim_due_events, deliver_claimed_event, recover_stale_claims
from app.services.relationship_followup_service import next_followup_time, relationship_followup_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def add_user(db: Session, user_id: str) -> User:
    user = User(id=user_id, email=f"{user_id}@example.test", name=f"User {user_id}", username=user_id, hashed_password="unused", is_active=True)
    db.add(user)
    db.commit()
    return user


def payload(request_id: str = "relationship-request-1", *, cadence: str = "weekly", interval: int | None = None) -> ContactCreate:
    return ContactCreate(
        display_name="Maa",
        relationship_type="family",
        preferred_channel="phone",
        contact_value="+91 99999 99999",
        last_contacted_at=datetime.now(UTC) - timedelta(days=2),
        cadence=cadence,
        followup_interval_days=interval,
        next_followup_at=datetime.now(UTC) + timedelta(days=1),
        preferred_reminder_time="10:00",
        timezone="Asia/Kolkata",
        priority="high",
        notes="Ask about health",
        preferred_language="hi",
        client_request_id=request_id,
    )


def api_client(db: Session, current: dict[str, User]) -> TestClient:
    app = FastAPI()
    app.include_router(relationship_followups.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: (yield db)
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    return TestClient(app)


def create_json(request_id: str = "relationship-api-request-1") -> dict[str, object]:
    return {
        "display_name": "Maa",
        "relationship_type": "family",
        "preferred_channel": "phone",
        "contact_value": "+91 99999 99999",
        "last_contacted_at": (datetime.now(UTC) - timedelta(days=2)).isoformat(),
        "cadence": "weekly",
        "followup_interval_days": 7,
        "next_followup_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
        "preferred_reminder_time": "10:00",
        "timezone": "Asia/Kolkata",
        "priority": "high",
        "notes": "Ask about health",
        "preferred_language": "hi",
        "client_request_id": request_id,
    }


def test_authenticated_crud_encrypts_private_fields_and_isolates_users(db: Session) -> None:
    first = add_user(db, "relationship-first")
    second = add_user(db, "relationship-second")
    current = {"user": first}
    client = api_client(db, current)

    created_response = client.post("/api/v1/relationship-followups", json=create_json())
    assert created_response.status_code == 201
    created = created_response.json()
    assert created["contact_value"] == "+91 99999 99999"
    assert created["notes"] == "Ask about health"
    stored = db.get(RelationshipContact, created["id"])
    assert stored and "+91" not in stored.contact_value_ciphertext and "health" not in stored.notes_ciphertext
    assert db.query(RelationshipFollowupEvent).filter_by(relationship_contact_id=created["id"], status="pending").count() == 1
    assert client.get("/api/v1/relationship-followups").json()["total"] == 1

    updated = client.patch(f"/api/v1/relationship-followups/{created['id']}", json={
        **{key: value for key, value in create_json().items() if key != "client_request_id"},
        "display_name": "Mother",
        "revision": created["revision"],
        "request_id": "relationship-update-1",
    })
    assert updated.status_code == 200 and updated.json()["display_name"] == "Mother" and updated.json()["revision"] == 2
    stale = client.patch(f"/api/v1/relationship-followups/{created['id']}", json={
        "display_name": "Stale",
        "revision": 1,
        "request_id": "relationship-update-stale",
    })
    assert stale.status_code == 409

    current["user"] = second
    assert client.get(f"/api/v1/relationship-followups/{created['id']}").status_code == 404
    assert client.get("/api/v1/relationship-followups").json()["total"] == 0


def test_invalid_dates_timezone_and_custom_interval_are_rejected(db: Session) -> None:
    current = {"user": add_user(db, "relationship-validation")}
    client = api_client(db, current)
    past = {**create_json("relationship-invalid-past"), "next_followup_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat()}
    assert client.post("/api/v1/relationship-followups", json=past).status_code == 422
    invalid_zone = {**create_json("relationship-invalid-zone"), "timezone": "Not/AZone"}
    assert client.post("/api/v1/relationship-followups", json=invalid_zone).status_code == 422
    custom = {**create_json("relationship-invalid-custom"), "cadence": "custom", "followup_interval_days": None}
    assert client.post("/api/v1/relationship-followups", json=custom).status_code == 422


@pytest.mark.parametrize(("cadence", "days", "expected_days"), [("weekly", None, 7), ("fortnightly", None, 15), ("custom", 40, 40)])
def test_daily_cadences_calculate_next_reminder(db: Session, cadence: str, days: int | None, expected_days: int) -> None:
    user = add_user(db, f"relationship-{cadence}")
    contact = relationship_followup_service.create(db, user.id, payload(f"relationship-{cadence}-request", cadence=cadence, interval=days))
    contacted = datetime(2026, 1, 15, 4, 30)
    next_due = next_followup_time(contact, contacted)
    local_days = (next_due.date() - contacted.date()).days
    assert local_days in {expected_days - 1, expected_days}
    assert next_due.replace(tzinfo=UTC).astimezone(__import__("zoneinfo").ZoneInfo("Asia/Kolkata")).strftime("%H:%M") == "10:00"


def test_monthly_and_quarterly_cadence_use_calendar_months_and_dst_safe_timezone(db: Session) -> None:
    user = add_user(db, "relationship-calendar")
    monthly = relationship_followup_service.create(db, user.id, payload("relationship-monthly-request", cadence="monthly"))
    monthly.timezone = "America/New_York"
    monthly.preferred_reminder_time = "09:15"
    month_due = next_followup_time(monthly, datetime(2026, 2, 28, 15, 0))
    month_local = month_due.replace(tzinfo=UTC).astimezone(__import__("zoneinfo").ZoneInfo("America/New_York"))
    assert (month_local.month, month_local.day, month_local.hour, month_local.minute) == (3, 28, 9, 15)
    monthly.cadence = "quarterly"
    quarter_local = next_followup_time(monthly, datetime(2026, 11, 30, 15, 0)).replace(tzinfo=UTC).astimezone(__import__("zoneinfo").ZoneInfo("America/New_York"))
    assert (quarter_local.year, quarter_local.month, quarter_local.day) == (2027, 2, 28)


def test_contacted_snooze_reschedule_pause_resume_archive_and_history(db: Session) -> None:
    user = add_user(db, "relationship-actions")
    current = {"user": user}
    client = api_client(db, current)
    contact = client.post("/api/v1/relationship-followups", json=create_json("relationship-actions-create")).json()
    contacted = client.post(f"/api/v1/relationship-followups/{contact['id']}/contacted", json={
        "revision": contact["revision"], "request_id": "relationship-contacted-1", "contacted_at": datetime.now(UTC).isoformat(), "channel": "phone", "note": "Had a good call"
    }).json()
    assert contacted["last_contacted_at"] and contacted["revision"] == 2
    assert db.query(RelationshipInteraction).filter_by(user_id=user.id).count() == 1
    assert client.post(f"/api/v1/relationship-followups/{contact['id']}/contacted", json={
        "revision": 1, "request_id": "relationship-contacted-1", "contacted_at": datetime.now(UTC).isoformat(), "channel": "phone", "note": "duplicate"
    }).json()["revision"] == 2

    snoozed = client.post(f"/api/v1/relationship-followups/{contact['id']}/snooze", json={"revision": 2, "request_id": "relationship-snooze-1", "minutes": 60}).json()
    assert snoozed["revision"] == 3
    rescheduled_time = datetime.now(UTC) + timedelta(days=4)
    rescheduled = client.post(f"/api/v1/relationship-followups/{contact['id']}/reschedule", json={"revision": 3, "request_id": "relationship-reschedule-1", "scheduled_at": rescheduled_time.isoformat()}).json()
    assert abs(datetime.fromisoformat(rescheduled["next_followup_at"]).timestamp() - rescheduled_time.timestamp()) < 2
    paused = client.post(f"/api/v1/relationship-followups/{contact['id']}/pause", json={"revision": 4, "request_id": "relationship-pause-1"}).json()
    assert paused["status"] == "paused"
    resumed = client.post(f"/api/v1/relationship-followups/{contact['id']}/resume", json={"revision": 5, "request_id": "relationship-resume-1"}).json()
    assert resumed["status"] == "active"
    archived = client.post(f"/api/v1/relationship-followups/{contact['id']}/archive", json={"revision": 6, "request_id": "relationship-archive-1"}).json()
    assert archived["status"] == "archived"
    assert db.query(RelationshipFollowupEvent).filter_by(relationship_contact_id=contact["id"], status="cancelled").count() >= 1
    history = client.get(f"/api/v1/relationship-followups/{contact['id']}/history").json()
    assert history[0]["note"] == "Had a good call"
    assert db.query(RelationshipAuditEvent).filter_by(user_id=user.id).count() >= 7


def due_contact(db: Session, user_id: str) -> tuple[RelationshipContact, RelationshipFollowupEvent]:
    contact = relationship_followup_service.create(db, user_id, payload(f"relationship-due-{user_id}"))
    event = db.scalar(select(RelationshipFollowupEvent).where(RelationshipFollowupEvent.relationship_contact_id == contact.id))
    assert event
    due = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
    contact.next_followup_at = due
    event.scheduled_at = due
    event.deduplication_key = f"due:{contact.id}"
    preference = RelationshipNotificationPreference(user_id=user_id, enabled=True, detailed_preview=False, permission_state="granted")
    db.add(preference)
    db.commit()
    return contact, event


def test_scheduler_claim_is_atomic_deduplicated_and_restart_safe(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user = add_user(db, "relationship-scheduler")
    contact, event = due_contact(db, user.id)
    device = UserDevice(user_id=user.id, device_id="android-relationship", platform="android", fcm_token_ciphertext=encrypt_token("valid-fcm-token-123456"), is_active=True)
    db.add(device)
    db.commit()
    claims = claim_due_events(db, 10)
    assert len(claims) == 1 and claim_due_events(db, 10) == []
    sent_payloads: list[dict[str, str]] = []
    monkeypatch.setattr("app.services.relationship_followup_scheduler.firebase_notification_service.send_relationship_followup", lambda _token, data, *_args, **_kwargs: sent_payloads.append(data) or FcmSendResult(ok=True))
    assert deliver_claimed_event(db, *claims[0]) is True
    db.refresh(event)
    assert event.status == "sent" and event.notification_event_id == f"relationship:{event.id}"
    assert sent_payloads[0]["destination"] == "RELATIONSHIP_FOLLOWUP" and sent_payloads[0]["entity_id"] == contact.id
    assert "Maa" not in sent_payloads[0].values()
    assert db.query(RelationshipDeliveryAttempt).filter_by(event_id=event.id, status="sent").count() == 1
    assert claim_due_events(db, 10) == []


def test_scheduler_recovers_stale_claim_retries_failure_and_removes_stale_token(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user = add_user(db, "relationship-recovery")
    _, event = due_contact(db, user.id)
    device = UserDevice(user_id=user.id, device_id="stale-android", platform="android", fcm_token_ciphertext=encrypt_token("stale-fcm-token-123456"), is_active=True)
    db.add(device)
    event.status = "processing"
    event.claim_token = "dead-worker"
    event.claimed_at = datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=20)
    db.commit()
    assert recover_stale_claims(db) == 1
    claims = claim_due_events(db, 10)
    monkeypatch.setattr("app.services.relationship_followup_scheduler.firebase_notification_service.send_relationship_followup", lambda *_args, **_kwargs: FcmSendResult(ok=False, inactive=True, failure_code="FCM_TOKEN_UNREGISTERED"))
    assert deliver_claimed_event(db, *claims[0]) is False
    db.refresh(event)
    db.refresh(device)
    assert event.status == "pending" and event.next_attempt_at is not None
    assert device.is_active is False and device.fcm_token_ciphertext is None
    assert db.query(RelationshipDeliveryAttempt).filter_by(event_id=event.id, failure_code="FCM_TOKEN_UNREGISTERED").count() == 1


def test_disabled_preference_is_never_claimed(db: Session) -> None:
    user = add_user(db, "relationship-disabled")
    _, event = due_contact(db, user.id)
    preference = db.scalar(select(RelationshipNotificationPreference).where(RelationshipNotificationPreference.user_id == user.id))
    preference.enabled = False
    db.commit()
    assert claim_due_events(db, 10) == []
    db.refresh(event)
    assert event.status == "pending" and event.attempt_count == 0


def test_ai_provider_failure_is_truthful_and_manual_feature_remains_available(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    user = add_user(db, "relationship-ai")
    current = {"user": user}
    client = api_client(db, current)
    contact = client.post("/api/v1/relationship-followups", json=create_json("relationship-ai-create")).json()
    monkeypatch.setattr("app.api.routes.relationship_followups.groq_service.complete", lambda *_args, **_kwargs: (_ for _ in ()).throw(HTTPException(status_code=503, detail="AI unavailable")))
    failed = client.post(f"/api/v1/relationship-followups/{contact['id']}/ai-suggestion", json={"language": "hi", "tone": "caring", "context": "illness"})
    assert failed.status_code == 503 and failed.json()["detail"] == "AI unavailable"
    assert client.get(f"/api/v1/relationship-followups/{contact['id']}").status_code == 200


def test_expired_or_missing_session_is_rejected(db: Session) -> None:
    app = FastAPI()
    app.include_router(relationship_followups.router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: (yield db)
    response = TestClient(app).get("/api/v1/relationship-followups")
    assert response.status_code == 401


def test_relationship_payload_limit_and_request_id_are_structured() -> None:
    app = FastAPI()

    @app.post("/api/v1/relationship-followups")
    async def create_contact() -> dict[str, bool]:
        return {"ok": True}

    app.add_middleware(RelationshipPayloadLimitMiddleware)
    app.add_middleware(RequestIdMiddleware)
    response = TestClient(app).post(
        "/api/v1/relationship-followups",
        content=b"x" * (RelationshipPayloadLimitMiddleware.MAX_BYTES + 1),
        headers={"content-type": "application/json", "x-request-id": "relationship-request-123"},
    )
    assert response.status_code == 413
    assert response.headers["x-request-id"] == "relationship-request-123"
    assert response.json() == {
        "detail": "Relationship follow-up request is too large.",
        "request_id": "relationship-request-123",
    }


def test_relationship_routes_are_rate_limited() -> None:
    app = FastAPI()

    @app.get("/api/v1/relationship-followups")
    async def list_contacts() -> dict[str, list[object]]:
        return {"items": []}

    app.add_middleware(InMemoryRateLimitMiddleware, limit_per_minute=2)
    client = TestClient(app)
    assert client.get("/api/v1/relationship-followups").status_code == 200
    assert client.get("/api/v1/relationship-followups").status_code == 200
    limited = client.get("/api/v1/relationship-followups")
    assert limited.status_code == 429
    assert limited.headers["x-ratelimit-remaining"] == "0"
