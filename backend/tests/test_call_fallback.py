from app.services.firebase_notifications import FirebaseNotificationService, FcmSendResult


def test_system_fallback_contains_notification_data_channel_tag_and_label(monkeypatch):
    service = FirebaseNotificationService()
    captured = {}
    monkeypatch.setattr(service, "_send", lambda message: captured.update(message) or FcmSendResult(ok=True))
    result = service.send_call_system_fallback(
        "secret-token", {"type": "incoming_call_fallback", "call_id": "call-1"},
        "Caller", "Incoming AutoAI audio call", 25, "autoai_call_call-1",
    )
    message = captured["message"]
    assert result.ok
    assert message["notification"]["title"] == "Caller"
    assert message["data"]["call_id"] == "call-1"
    assert message["android"]["notification"]["channel_id"] == "auto_ai_incoming_calls_v4"
    assert message["android"]["notification"]["tag"] == "autoai_call_call-1"
    assert message["android"]["fcm_options"]["analytics_label"] == "incoming_call_fallback"
