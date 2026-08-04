from datetime import datetime, timedelta
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.db.base import Base
from app.models.trust_hub import HubAuthoritySetting, HubConsentLease, HubEmergencyPause, HubPolicyRule
from app.models.user import User
from app.services.trust_gateway import GatewayInput, GatewayStatus, authorize_and_execute
from app.services.assistant_action_service import AlarmCreateArgs, assistant_action_service
from datetime import UTC

def database():
    engine = create_engine("sqlite:///:memory:"); Base.metadata.create_all(engine); return Session(engine)

def add_user(db, user_id="u1"):
    user = User(id=user_id, email=f"{user_id}@x.test", name=user_id, username=user_id, hashed_password="x", is_active=True); db.add(user); db.commit(); return user

def test_denied_message_never_reaches_adapter():
    with database() as db:
        user = add_user(db); db.add(HubPolicyRule(user_id=user.id, name="Never send", domain="messages", effect="DENY", conditions={"action_type": "message.send"}, priority=10)); db.commit()
        calls = []
        result = authorize_and_execute(db, user.id, GatewayInput("messages", "message.send", {"text": "hello"}, "message-request-1"), lambda payload: calls.append(payload) or {"id": "sent"})
        assert result.status == GatewayStatus.DENIED
        assert calls == []

def test_consent_without_os_permission_blocks_adapter():
    with database() as db:
        user = add_user(db); db.add(HubConsentLease(user_id=user.id, capability="MICROPHONE", purpose="Start call", fields=[], status="ACTIVE", os_permission_granted=False, expires_at=datetime.utcnow() + timedelta(hours=1))); db.commit()
        called = False
        def adapter(_):
            nonlocal called; called = True; return {"id": "call"}
        result = authorize_and_execute(db, user.id, GatewayInput("calls", "call.start", {}, "call-request-1", required_capability="MICROPHONE"), adapter)
        assert result.status == GatewayStatus.DENIED
        assert called is False

def test_confirmation_is_required_before_execution_and_receipt_is_unverified():
    with database() as db:
        user = add_user(db); db.add(HubAuthoritySetting(user_id=user.id, domain="alarms", level="EXECUTE_AFTER_CONFIRMATION")); db.commit(); calls = []
        proposal = GatewayInput("alarms", "alarm.create", {"title": "Study"}, "alarm-request-1")
        first = authorize_and_execute(db, user.id, proposal, lambda payload: calls.append(payload) or {"id": "alarm-1"})
        assert first.status == GatewayStatus.CONFIRMATION_REQUIRED and calls == []
        second = authorize_and_execute(db, user.id, proposal, lambda payload: calls.append(payload) or {"id": "alarm-1"}, confirmed_token=first.confirmation_token)
        assert second.status == GatewayStatus.EXECUTED and calls == [{"title": "Study"}]
        assert second.receipt_id and "unverified" in second.explanation.lower()

def test_real_alarm_create_executes_through_gateway():
    with database() as db:
        user = add_user(db)
        args = AlarmCreateArgs(title="College", scheduled_at=datetime.now(UTC) + timedelta(hours=2), timezone="Asia/Kolkata", client_request_id="gateway-alarm-1")
        result = authorize_and_execute(db, user.id, GatewayInput("alarm", "alarm.create", args.model_dump(mode="json"), "gateway-alarm-1"), lambda _: assistant_action_service.execute(db, user, "alarm.create", args, "gateway-alarm-1"))
        assert result.status == GatewayStatus.EXECUTED
        assert result.adapter_result["alarm"]["title"] == "College"

def test_server_verified_confirmation_executes_high_risk_action_once():
    with database() as db:
        user = add_user(db); calls = []
        proposal = GatewayInput("alarm", "alarm.delete", {"target": "College"}, "delete-alarm-1")
        result = authorize_and_execute(db, user.id, proposal, lambda payload: calls.append(payload) or {"id": "alarm-1"}, preconfirmed=True)
        assert result.status == GatewayStatus.EXECUTED
        assert calls == [{"target": "College"}]

def test_emergency_pause_prevents_adapter_execution():
    with database() as db:
        user = add_user(db); db.add(HubEmergencyPause(user_id=user.id, active=True, reason="Reviewing actions")); db.commit(); calls = []
        result = authorize_and_execute(db, user.id, GatewayInput("alarm", "alarm.create", {"title": "Study"}, "paused-alarm-1"), lambda payload: calls.append(payload) or {"id": "alarm-1"})
        assert result.status == GatewayStatus.DENIED
        assert calls == []
        assert "pause" in result.explanation.lower()
