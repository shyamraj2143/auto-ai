from unittest.mock import Mock

from fastapi import BackgroundTasks

from app.api.routes import notifications
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
