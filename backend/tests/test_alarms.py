import asyncio
import io
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import BackgroundTasks, HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes.alarms import alarm_action, create_alarm, delete_alarm, list_alarms, update_alarm, verify_alarm_awake
from app.db.base import Base
from app.models.alarm import UserAlarm
from app.models.user import User
from app.schemas.alarm import AlarmAction, AlarmCreate, AlarmUpdate
from app.services.alarm_ai_service import AlarmMessage, alarm_ai_service
from app.services.alarm_awake_service import AwakeDecision, AlarmAwakeService, alarm_awake_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def user(db: Session, user_id: str = "alarm-user") -> User:
    record = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name="Shyam Raj",
        username=user_id,
        hashed_password="unused",
        is_active=True,
    )
    db.add(record)
    db.commit()
    return record


def alarm_payload(hours: int = 2) -> AlarmCreate:
    return AlarmCreate(
        title="Office",
        note="I have to leave for the office by 8:30 AM.",
        scheduled_at=datetime.now(UTC) + timedelta(hours=hours),
        timezone="Asia/Kolkata",
        language="hinglish-IN",
        voice_style="warm",
        ringtone="system",
    )


def test_alarm_crud_is_user_scoped_and_returns_utc_time(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = user(db)
    other = user(db, "other-user")
    monkeypatch.setattr(
        alarm_ai_service,
        "compose",
        lambda **_: AlarmMessage("Shyam sir, उठ जाइए। आपको ऑफिस जाना है।", "llama-alarm", True),
    )

    created = create_alarm(alarm_payload(), BackgroundTasks(), db, current)
    assert created.ai_generated is True
    assert created.ai_model == "llama-alarm"
    assert created.scheduled_at.utcoffset() == timedelta(0)
    assert list_alarms(False, db, current).items[0].id == created.id
    assert list_alarms(False, db, other).items == []

    updated = update_alarm(
        created.id,
        AlarmUpdate(title="Office meeting", ringtone="energetic"),
        BackgroundTasks(),
        db,
        current,
    )
    assert updated.title == "Office meeting"
    assert updated.ringtone == "energetic"
    assert updated.revision == 2

    with pytest.raises(HTTPException) as forbidden_lookup:
        update_alarm(created.id, AlarmUpdate(title="Wrong user"), BackgroundTasks(), db, other)
    assert forbidden_lookup.value.status_code == 404

    response = delete_alarm(created.id, BackgroundTasks(), db, current)
    assert response.status_code == 204
    assert db.get(UserAlarm, created.id) is None


def test_snooze_and_dismiss_are_durable(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = user(db)
    monkeypatch.setattr(alarm_ai_service, "compose", lambda **_: AlarmMessage("Wake up for class.", "groq-test", True))
    created = create_alarm(alarm_payload(), BackgroundTasks(), db, current)

    before = datetime.now(UTC)
    snoozed = alarm_action(
        created.id,
        AlarmAction(action="snooze", snooze_minutes=15),
        BackgroundTasks(),
        db,
        current,
    )
    assert snoozed.status == "scheduled"
    assert snoozed.enabled is True
    assert snoozed.snooze_count == 1
    assert snoozed.scheduled_at >= before + timedelta(minutes=14)

    dismissed = alarm_action(
        created.id,
        AlarmAction(action="dismiss"),
        BackgroundTasks(),
        db,
        current,
    )
    assert dismissed.status == "completed"
    assert dismissed.enabled is False
    assert list_alarms(False, db, current).items == []
    assert list_alarms(True, db, current).items[0].status == "completed"


def test_native_alarm_actions_are_ordered_and_idempotent(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = user(db)
    monkeypatch.setattr(alarm_ai_service, "compose", lambda **_: AlarmMessage("Wake up.", "groq-test", True))
    created = create_alarm(alarm_payload(), BackgroundTasks(), db, current)
    exact_snooze = datetime.now(UTC) + timedelta(minutes=18)

    snoozed = alarm_action(
        created.id,
        AlarmAction(action="snooze", scheduled_at=exact_snooze, client_revision=2),
        BackgroundTasks(),
        db,
        current,
    )
    assert snoozed.revision == 2
    assert abs((snoozed.scheduled_at - exact_snooze).total_seconds()) < 1

    repeated = alarm_action(
        created.id,
        AlarmAction(action="snooze", scheduled_at=exact_snooze, client_revision=2),
        BackgroundTasks(),
        db,
        current,
    )
    assert repeated.revision == 2

    stale = alarm_action(
        created.id,
        AlarmAction(action="snooze", snooze_minutes=30, client_revision=1),
        BackgroundTasks(),
        db,
        current,
    )
    assert stale.revision == 2
    assert stale.scheduled_at == repeated.scheduled_at


def test_alarm_rejects_naive_and_past_times(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    current = user(db)
    monkeypatch.setattr(alarm_ai_service, "compose", lambda **_: AlarmMessage("Wake up.", "groq-test", True))
    naive = alarm_payload().model_copy(update={"scheduled_at": datetime.utcnow() + timedelta(hours=1)})
    past = alarm_payload().model_copy(update={"scheduled_at": datetime.now(UTC) - timedelta(minutes=1)})
    for payload in (naive, past):
        with pytest.raises(HTTPException) as invalid:
            create_alarm(payload, BackgroundTasks(), db, current)
        assert invalid.value.status_code == 422


def test_alarm_rejects_blank_normalized_title() -> None:
    with pytest.raises(ValueError):
        AlarmCreate(
            title="   ",
            scheduled_at=datetime.now(UTC) + timedelta(hours=1),
        )


def test_ai_failure_uses_human_local_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import alarm_ai_service as module

    monkeypatch.setattr(module.groq_service, "complete", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("offline")))
    result = alarm_ai_service.compose(
        user_name="Shyam Raj",
        title="Office",
        note="ऑफिस जाना है",
        language="hi-IN",
        voice_style="warm",
    )
    assert result.generated is False
    assert "उठ जाइए" in result.text
    assert "ऑफिस जाना है" in result.text


def test_awake_photo_is_user_scoped_ephemeral_and_returns_groq_decision(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = user(db)
    other = user(db, "awake-other")
    monkeypatch.setattr(alarm_ai_service, "compose", lambda **_: AlarmMessage("Wake up.", "groq-test", True))
    alarm = create_alarm(alarm_payload(), BackgroundTasks(), db, current)
    monkeypatch.setattr(
        alarm_awake_service,
        "verify",
        lambda **_: AwakeDecision(True, .91, "Both eyes are open.", "qwen-awake-test"),
    )
    upload = UploadFile(filename="awake.jpg", file=io.BytesIO(b"\xff\xd8\xff" + b"face" * 40))
    result = asyncio.run(verify_alarm_awake(alarm.id, upload, db, current))
    assert result.awake is True
    assert result.confidence == .91
    assert result.model == "qwen-awake-test"
    assert result.photo_stored is False

    with pytest.raises(HTTPException) as missing:
        asyncio.run(
            verify_alarm_awake(
                alarm.id,
                UploadFile(filename="awake.jpg", file=io.BytesIO(b"\xff\xd8\xffphoto")),
                db,
                other,
            )
        )
    assert missing.value.status_code == 404


def test_alarm_awake_service_requires_strict_json_and_groq_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import alarm_awake_service as module

    captured: dict = {}

    def complete(*args, **kwargs):
        captured.update(kwargs)
        return '{"awake":true,"confidence":0.88,"reason":"Face is upright and eyes are open."}', {}, "groq-awake"

    monkeypatch.setattr(module.groq_service, "complete", complete)
    decision = AlarmAwakeService().verify(image=b"\xff\xd8\xffphoto", filename="awake.jpg")
    assert decision.awake is True
    assert decision.confidence == .88
    assert captured["provider"] == "groq"
    assert captured["allow_bedrock_fallback"] is False

    with pytest.raises(HTTPException) as invalid:
        AlarmAwakeService.parse_json("The person seems awake")
    assert invalid.value.status_code == 502
