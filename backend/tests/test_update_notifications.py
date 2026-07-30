from unittest.mock import Mock

from fastapi import BackgroundTasks
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes import admin
from app.api.routes import notifications
from app.core.config import settings
from app.db.base import Base
from app.schemas.download import ApkVersionUpsert
from app.schemas.notifications import ApkUpdateNotificationRequest


def test_apk_update_notification_is_queued_without_blocking_request(monkeypatch) -> None:
    request = Mock(headers={"x-auto-ai-notify-secret": "test-secret"})
    background_tasks = BackgroundTasks()
    monkeypatch.setattr(notifications, "notify_secret_value", lambda: "test-secret")
    monkeypatch.setattr(
        type(notifications.firebase_notification_service),
        "configured",
        property(lambda _self: True),
    )

    response = notifications.notify_apk_update(
        ApkUpdateNotificationRequest(
            version_code=101471,
            version_name="1.0.101471",
            changelog="Call Hub fixes",
        ),
        request,
        background_tasks,
    )

    assert response.detail == "Notification dispatch queued."
    assert response.sent == 0
    assert len(background_tasks.tasks) == 1


def test_admin_metadata_publish_queues_update_notification(tmp_path, monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    background_tasks = BackgroundTasks()
    monkeypatch.setattr(settings, "APK_STORAGE_DIR", str(tmp_path))
    monkeypatch.setattr(
        type(admin.firebase_notification_service),
        "configured",
        property(lambda _self: True),
    )

    with Session(engine) as db:
        release = admin.upsert_apk_version(
            ApkVersionUpsert(
                version_code=101491,
                version_name="1.0.101491",
                apk_url="/api/download/apk/github/latest?version=1.0.101491",
                file_name="auto-ai.apk",
                file_size=55_374_476,
                sha256="b" * 64,
                changelog="Call Hub fixes",
            ),
            background_tasks,
            object(),
            db,
        )

    assert release.version_code == 101491
    assert len(background_tasks.tasks) == 1
