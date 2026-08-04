from datetime import UTC, datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.user import User
from app.services.assistant_action_service import AlarmCreateArgs, AlarmTargetArgs, assistant_action_service, registry


def make_db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def make_user(db: Session, user_id: str) -> User:
    record = User(id=user_id, email=f"{user_id}@example.test", name=user_id, username=user_id, hashed_password="unused", is_active=True)
    db.add(record); db.commit(); return record


def test_registry_exposes_only_allowlisted_platform_actions() -> None:
    names = {item["name"] for item in registry.prompt_catalog("android")}
    assert names == {"alarm.create", "alarm.update", "alarm.delete", "alarm.enable", "alarm.disable", "alarm.snooze", "alarm.list", "navigation.open_screen", "settings.get", "settings.update"}
    assert registry.get("alarm.delete").confirmation is True


def test_alarm_create_is_idempotent_and_user_scoped() -> None:
    with make_db() as db:
        first_user, second_user = make_user(db, "first"), make_user(db, "second")
        args = AlarmCreateArgs(label="Study", note="exam", scheduled_at=datetime.now(UTC) + timedelta(hours=2), timezone="Asia/Kolkata", client_request_id="request-123")
        first = assistant_action_service.execute(db, first_user, "alarm.create", args, "request-123")
        duplicate = assistant_action_service.execute(db, first_user, "alarm.create", args, "request-123")
        other = assistant_action_service.execute(db, second_user, "alarm.create", args, "request-123")
        assert first["alarm"]["id"] == duplicate["alarm"]["id"]
        assert duplicate["duplicate"] is True
        assert other["alarm"]["id"] != first["alarm"]["id"]
        assert assistant_action_service._target(db, first_user.id, AlarmTargetArgs(target="Study")).id == first["alarm"]["id"]
