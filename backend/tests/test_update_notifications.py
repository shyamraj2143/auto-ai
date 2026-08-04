from unittest.mock import Mock

from fastapi import BackgroundTasks
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes import admin
from app.api.routes import notifications
from app.core.config import settings
from app.db.base import Base
from app.schemas.download import ApkVersionUpsert
from app.schemas.notifications import ApkUpdateNotificationRequest, DeviceTokenRegisterRequest
from app.models.call import UserDevice
from app.models.user import User
from app.services.device_token_security import encrypt_token, token_hash
from app.services.firebase_notifications import FcmSendResult
from fastapi import HTTPException
import pytest


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


def test_admin_metadata_retry_does_not_queue_duplicate_notification(tmp_path, monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(settings, "APK_STORAGE_DIR", str(tmp_path))
    monkeypatch.setattr(type(admin.firebase_notification_service), "configured", property(lambda _self: True))
    payload = ApkVersionUpsert(version_code=101492, version_name="1.0.101492", apk_url="/api/download/apk/github/latest?version=1.0.101492", file_name="auto-ai.apk", file_size=123, sha256="c" * 64, changelog="Retry-safe")
    with Session(engine) as db:
        first = BackgroundTasks()
        admin.upsert_apk_version(payload, first, object(), db)
        retry = BackgroundTasks()
        admin.upsert_apk_version(payload, retry, object(), db)
    assert len(first.tasks) == 1
    assert retry.tasks == []


def test_legacy_unauthenticated_push_token_registration_is_rejected() -> None:
    with pytest.raises(HTTPException) as error:
        notifications.register_device_token(DeviceTokenRegisterRequest(token="x" * 32), object())
    assert error.value.status_code == 410


def test_update_notifications_use_encrypted_user_device_token(monkeypatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        user = User(id="push-user", email="push@example.test", name="Push", username="push-user", hashed_password="x", is_active=True)
        target = "firebase-target-12345678901234567890"
        db.add(user); db.add(UserDevice(user_id=user.id, device_id="android-1", platform="android", is_active=True, fcm_token_ciphertext=encrypt_token(target), fcm_token_hash=token_hash(target))); db.commit()
    class SessionContext:
        def __enter__(self): self.db = Session(engine); return self.db
        def __exit__(self, *_): self.db.close()
    sent = []
    monkeypatch.setattr(notifications, "SessionLocal", SessionContext)
    monkeypatch.setattr(notifications.firebase_notification_service, "send_update_notification", lambda token, **kwargs: sent.append((token, kwargs)) or FcmSendResult(ok=True))
    notifications.dispatch_apk_update_notifications(101500, "1.0.101500", "Secure push")
    assert sent[0][0] == target
