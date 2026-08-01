from app.services.firebase_notifications import FirebaseNotificationService, FcmSendResult


def test_primary_call_is_immediate_high_priority_data_only_and_package_restricted(monkeypatch):
    service = FirebaseNotificationService()
    captured = {}
    monkeypatch.setattr(service, "_send", lambda message: captured.update(message) or FcmSendResult(ok=True))
    service.send_call_data(
        "firebase-installation-id",
        {"type": "incoming_call", "call_id": "call-a"},
        30,
        target_kind="fid",
    )
    message = captured["message"]
    assert message["fid"] == "firebase-installation-id"
    assert "token" not in message
    assert "notification" not in message
    assert message["android"]["priority"] == "HIGH"
    assert message["android"]["ttl"] == "30s"
    assert message["android"]["restricted_package_name"] == "com.autoai.app"
    assert message["android"]["collapse_key"] == "call_call-a"
    assert message["android"]["fcm_options"]["analytics_label"] == "incoming_call_primary"


def test_chat_notification_targets_registered_fid(monkeypatch):
    service = FirebaseNotificationService()
    captured = {}
    monkeypatch.setattr(service, "_send", lambda message: captured.update(message) or FcmSendResult(ok=True))

    service.send_chat_data(
        "firebase-installation-id",
        {"type": "chat_message", "message_id": "message-a"},
        "Sender",
        "Hello",
        target_kind="fid",
    )

    message = captured["message"]
    assert message["fid"] == "firebase-installation-id"
    assert "token" not in message
    assert message["android"]["priority"] == "HIGH"
    assert message["notification"]["body"] == "Hello"
