from datetime import datetime, timezone
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest
from pydantic import SecretStr, ValidationError
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.routes.calls import call_health, discoverable_users_query, register_call_device, ringing_call, search_users
from app.core.config import settings
from app.db.base import Base
from app.models.call import BlockedUser, Call, UserCallSettings, UserDevice
from app.models.user import User
from app.schemas.call import CallActionRequest, DeviceRegisterRequest, PublicCallUser, SignalEvent
from app.services.call_permission_service import call_allowed, get_or_create_call_settings, users_blocked
from app.services.call_notification_service import send_incoming_call_notifications
from app.services.call_service import CallService
from app.services.device_token_security import decrypt_token, encrypt_token, token_hash
from app.services.presence_service import PresenceService, RealtimeUnavailable
from app.services.presence_service import presence_service as global_presence_service
from app.services.turn_credentials_service import TURN_UNAVAILABLE_MESSAGE, create_turn_credentials
from app.websockets import call_signaling


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def create_user(db: Session, user_id: str, name: str) -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name=name,
        username=user_id,
        hashed_password="unused",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def test_discovery_requires_opt_in_and_excludes_blocked_users(db: Session) -> None:
    viewer = create_user(db, "viewer_user", "Viewer")
    visible = create_user(db, "visible_user", "Visible")
    hidden = create_user(db, "hidden_user", "Hidden")
    db.add_all(
        [
            UserCallSettings(user_id=visible.id, is_discoverable=True, call_permission="everyone"),
            UserCallSettings(user_id=hidden.id, is_discoverable=False, call_permission="everyone"),
            UserDevice(user_id=visible.id, device_id="visible-web", platform="web"),
        ]
    )
    db.commit()
    rows = db.execute(discoverable_users_query(viewer.id)).all()
    assert [user.id for user, _ in rows] == [visible.id]

    db.add(BlockedUser(blocker_id=viewer.id, blocked_user_id=visible.id))
    db.commit()
    assert db.execute(discoverable_users_query(viewer.id)).all() == []
    assert users_blocked(db, viewer.id, visible.id)


def test_call_permissions_respect_type_contact_and_block(db: Session) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    db.add(
        UserCallSettings(
            user_id=callee.id,
            is_discoverable=True,
            allow_audio_calls=True,
            allow_video_calls=False,
            call_permission="previous_contacts",
        )
    )
    db.commit()
    assert call_allowed(db, caller.id, callee.id, "audio") == (False, False)
    db.add(Call(caller_id=caller.id, callee_id=callee.id, call_type="audio", status="ended"))
    db.commit()
    assert call_allowed(db, caller.id, callee.id, "audio") == (True, True)
    assert call_allowed(db, caller.id, callee.id, "video") == (False, False)
    db.add(BlockedUser(blocker_id=callee.id, blocked_user_id=caller.id))
    db.commit()
    assert call_allowed(db, caller.id, callee.id, "audio") == (False, False)


def test_public_profile_never_contains_private_identity_fields() -> None:
    fields = set(PublicCallUser.model_fields)
    assert "email" not in fields
    assert "mobile" not in fields
    assert "fcm_token" not in fields


def test_new_call_settings_default_privacy_toggles_on(db: Session) -> None:
    user = create_user(db, "settings_user", "Settings User")
    settings_record = get_or_create_call_settings(db, user.id)

    assert settings_record.is_discoverable is True
    assert settings_record.show_online_status is True
    assert settings_record.show_last_seen is True


def test_fcm_token_encryption_roundtrip() -> None:
    raw = "fcm-token-value-123456"
    encrypted = encrypt_token(raw)

    assert encrypted
    assert encrypted != raw
    assert decrypt_token(encrypted) == raw
    assert token_hash(raw) == token_hash(raw)


def test_authenticated_device_registration_transfers_rotated_token(db: Session) -> None:
    old_user = create_user(db, "old_user", "Old User")
    new_user = create_user(db, "new_user", "New User")
    payload = DeviceRegisterRequest(
        device_id="android-device-1",
        platform="android",
        fcm_token="fcm-token-value-123456",
        app_version="1.0.18",
        app_version_code=20,
        device_name="Pixel Test",
    )

    register_call_device(payload, db=db, current_user=old_user)
    register_call_device(payload, db=db, current_user=new_user)

    devices = db.query(UserDevice).all()
    assert len(devices) == 1
    assert devices[0].user_id == new_user.id
    assert devices[0].device_id == "android-device-1"
    assert devices[0].fcm_token is None
    assert devices[0].fcm_token_ciphertext != payload.fcm_token
    assert devices[0].fcm_token_hash == token_hash(payload.fcm_token)
    assert devices[0].app_version_code == 20
    assert devices[0].device_name == "Pixel Test"


def test_incoming_call_fcm_payload_has_event_id_and_high_priority_path(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    call = Call(caller_id=caller.id, callee_id=callee.id, call_type="video", status="initiated")
    db.add_all(
        [
            call,
            UserCallSettings(user_id=callee.id),
            UserDevice(
                user_id=callee.id,
                device_id="callee-android",
                platform="android",
                is_active=True,
                fcm_token_ciphertext=encrypt_token("callee-fcm-token"),
                fcm_token_hash=token_hash("callee-fcm-token"),
            ),
        ]
    )
    db.commit()
    sent_payloads: list[dict[str, str]] = []

    class FakeFirebase:
        configured = True

        def send_call_data(self, token: str, data: dict[str, str], ttl_seconds: int):
            assert token == "callee-fcm-token"
            assert ttl_seconds == settings.CALL_NOTIFICATION_TTL_SECONDS
            sent_payloads.append(data)
            return type("Result", (), {"ok": True, "inactive": False, "detail": ""})()

    monkeypatch.setattr("app.services.call_notification_service.firebase_notification_service", FakeFirebase())

    sent = send_incoming_call_notifications(db, call, caller, UserCallSettings(user_id=callee.id), silent=False)

    assert sent == 1
    assert sent_payloads[0]["type"] == "incoming_call"
    assert sent_payloads[0]["call_id"] == call.id
    assert sent_payloads[0]["event_id"]


@pytest.mark.asyncio
async def test_metered_turn_credentials_are_fetched_and_validated(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[dict[str, str]]:
            return [
                {
                    "urls": "turn:autoai.metered.live:80",
                    "username": "metered-user",
                    "credential": "metered-credential",
                }
            ]

    class FakeAsyncClient:
        def __init__(self, timeout: float) -> None:
            captured["timeout"] = timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, url: str, params: dict[str, str]) -> FakeResponse:
            captured["url"] = url
            captured["params"] = params
            return FakeResponse()

    monkeypatch.setattr(settings, "TURN_PROVIDER", "metered")
    monkeypatch.setattr(settings, "METERED_DOMAIN", "autoai.metered.live")
    monkeypatch.setattr(settings, "METERED_TURN_API_KEY", SecretStr("secret-key"))
    monkeypatch.setattr(settings, "METERED_TURN_TIMEOUT_SECONDS", 2.5)
    monkeypatch.setattr("app.services.turn_credentials_service.httpx.AsyncClient", FakeAsyncClient)

    credentials = await create_turn_credentials("caller_user")

    assert credentials.configured is True
    assert credentials.provider == "metered"
    assert credentials.ice_servers[0]["urls"] == "turn:autoai.metered.live:80"
    assert captured["url"] == "https://autoai.metered.live/api/v1/turn/credentials"
    assert captured["params"] == {"apiKey": "secret-key"}
    assert captured["timeout"] == 2.5


@pytest.mark.asyncio
async def test_metered_turn_invalid_response_returns_controlled_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> list[dict[str, str]]:
            return [{"urls": "turn:autoai.metered.live:80"}]

    class FakeAsyncClient:
        def __init__(self, timeout: float) -> None:
            del timeout

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_: object) -> None:
            return None

        async def get(self, url: str, params: dict[str, str]) -> FakeResponse:
            del url, params
            return FakeResponse()

    monkeypatch.setattr(settings, "TURN_PROVIDER", "metered")
    monkeypatch.setattr(settings, "METERED_DOMAIN", "autoai.metered.live")
    monkeypatch.setattr(settings, "METERED_TURN_API_KEY", SecretStr("secret-key"))
    monkeypatch.setattr("app.services.turn_credentials_service.httpx.AsyncClient", FakeAsyncClient)

    with pytest.raises(RuntimeError, match=TURN_UNAVAILABLE_MESSAGE):
        await create_turn_credentials("caller_user")


@pytest.mark.parametrize(
    "redis_url",
    [
        "redis://default:password@redis.railway.internal:6379",
        "rediss://default:password@redis.railway.internal:6379",
    ],
)
def test_railway_redis_urls_are_forwarded_to_redis_client(
    redis_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, str] = {}
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)

    def fake_from_url(value: str, **_: object):
        captured["url"] = value
        return fake_redis

    monkeypatch.setattr(settings, "REDIS_URL", redis_url)
    monkeypatch.setattr("app.services.presence_service.Redis.from_url", fake_from_url)

    assert PresenceService().client() is fake_redis
    assert captured["url"] == redis_url


def test_signaling_schema_rejects_unknown_and_oversized_events() -> None:
    base = {
        "schema_version": 1,
        "event_id": "event-123456",
        "timestamp": datetime.now(timezone.utc),
        "payload": {},
    }
    with pytest.raises(ValidationError):
        SignalEvent.model_validate({**base, "type": "arbitrary.forward"})
    with pytest.raises(ValidationError):
        SignalEvent.model_validate({**base, "type": "ping", "payload": {str(index): index for index in range(40)}})


def test_call_state_machine_rejects_late_accept_state() -> None:
    call = Call(caller_id="caller", callee_id="callee", call_type="video", status="cancelled")
    with pytest.raises(Exception):
        CallService._require_state(call, {"initiated", "ringing"})


@pytest.mark.asyncio
async def test_redis_ticket_presence_deduplication_and_busy_locks(monkeypatch: pytest.MonkeyPatch) -> None:
    service = PresenceService()
    service._redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake/0")
    ticket = await service.create_ticket("user-a")
    assert await service.consume_ticket(ticket) == "user-a"
    assert await service.consume_ticket(ticket) is None

    await service.register_connection("user-a", "connection-a", "online")
    presence = await service.presence_for_user("user-a")
    assert presence["state"] == "online"
    assert presence["reachable"] is True

    assert await service.claim_event("user-a", "event-a") is True
    assert await service.claim_event("user-a", "event-a") is False
    assert await service.acquire_call_locks("call-a", "user-a", "user-b") is True
    assert await service.acquire_call_locks("call-b", "user-a", "user-c") is False
    await service.release_call_locks("call-a", ["user-a", "user-b"])
    assert await service.acquire_call_locks("call-b", "user-a", "user-c") is True
    await service.close()


@pytest.mark.asyncio
async def test_call_health_reports_reachable_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(settings, "REDIS_URL", "redis://default:secret@redis.internal:6379")
    monkeypatch.setattr(settings, "CALL_FEATURE_ENABLED", True)
    monkeypatch.setattr(global_presence_service, "_redis", fake_redis)

    health = await call_health()

    assert health.calling_enabled is True
    assert health.redis_configured is True
    assert health.redis_reachable is True
    assert health.websocket_ready is True


@pytest.mark.asyncio
async def test_discoverable_user_search_works_without_redis(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    viewer = create_user(db, "viewer_user", "Viewer")
    visible = create_user(db, "visible_user", "Visible")
    db.add_all(
        [
            UserCallSettings(
                user_id=visible.id,
                is_discoverable=True,
                show_online_status=True,
                call_permission="everyone",
            ),
            UserDevice(user_id=visible.id, device_id="visible-web", platform="web"),
        ]
    )
    db.commit()
    monkeypatch.setattr(
        global_presence_service,
        "allow_rate",
        AsyncMock(side_effect=RealtimeUnavailable("Redis unavailable")),
    )
    monkeypatch.setattr(
        global_presence_service,
        "presence_for_user",
        AsyncMock(side_effect=RealtimeUnavailable("Redis unavailable")),
    )

    page = await search_users(query="", page=1, limit=20, db=db, current_user=viewer)

    assert [item.id for item in page.items] == [visible.id]
    assert page.items[0].presence == "offline"
    assert page.items[0].availability == "Offline"


@pytest.mark.asyncio
async def test_presence_requires_live_connection_and_expires_after_ttl(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = PresenceService()
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    service._redis = fake_redis
    monkeypatch.setattr(settings, "REDIS_URL", "rediss://default:secret@redis.internal:6379")

    await service.register_connection("user-a", "connection-a", "online")
    await service.register_connection("user-b", "connection-b", "online")
    await fake_redis.set("calls:busy:user-b", "call-1", ex=60)

    assert (await service.presence_for_user("user-a"))["state"] == "online"
    assert (await service.presence_for_user("user-b"))["state"] == "busy"

    await fake_redis.delete("calls:connection:connection-a")
    expired = await service.presence_for_user("user-a")
    assert expired["state"] == "offline"
    assert expired["reachable"] is False
    await service.close()


def test_authenticated_websocket_ticket_and_ping(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    test_sessions = sessionmaker(bind=engine)
    with test_sessions() as db:
        create_user(db, "socket_user", "Socket User")
        db.commit()

    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake/0")
    monkeypatch.setattr(call_signaling, "SessionLocal", test_sessions)
    monkeypatch.setattr(global_presence_service, "_redis", fake_redis)
    monkeypatch.setattr(global_presence_service, "consume_ticket", AsyncMock(return_value="socket_user"))
    ticket = "single-use-test-ticket"

    app = FastAPI()
    app.include_router(call_signaling.router)
    with TestClient(app) as client:
        with client.websocket_connect(f"/calls/ws?ticket={ticket}") as websocket:
            snapshot = websocket.receive_json()
            assert snapshot["type"] == "presence.snapshot"
            websocket.send_json(
                {
                    "schema_version": 1,
                    "event_id": "ping-event-1",
                    "type": "ping",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": {},
                }
            )
            assert websocket.receive_json()["type"] == "pong"


@pytest.mark.asyncio
async def test_ringing_ack_endpoint_marks_call_ringing(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    call = Call(caller_id=caller.id, callee_id=callee.id, call_type="video", status="initiated")
    db.add(call)
    db.commit()
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=0))

    result = await ringing_call(call.id, payload=CallActionRequest(), db=db, current_user=callee)

    assert result.status == "ringing"
    assert result.ringing_at is not None


@pytest.mark.asyncio
async def test_accepted_call_is_not_expired_as_missed(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    call = Call(caller_id=caller.id, callee_id=callee.id, call_type="video", status="ringing")
    db.add(call)
    db.commit()
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(global_presence_service, "release_call_locks", AsyncMock(return_value=None))

    accepted = await CallService().accept(db, call.id, callee.id)
    expired = await CallService().accept(db, call.id, callee.id)

    assert accepted.status == "accepted"
    assert expired.status == "accepted"


@pytest.mark.asyncio
async def test_accepting_call_sends_dismiss_push_for_other_devices(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    call = Call(caller_id=caller.id, callee_id=callee.id, call_type="video", status="ringing")
    db.add(call)
    db.commit()
    dismisses: list[tuple[str, str]] = []
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(
        "app.services.call_service.send_call_dismiss_notifications",
        lambda _db, next_call, event_type: dismisses.append((next_call.id, event_type)) or 1,
    )

    accepted = await CallService().accept(db, call.id, callee.id, device_id="callee-android")

    assert accepted.status == "accepted"
    assert accepted.callee_device_id == "callee-android"
    assert dismisses == [(call.id, "call_accepted")]


@pytest.mark.asyncio
async def test_late_reject_after_accept_does_not_mark_callee_rejected(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    caller = create_user(db, "caller_user", "Caller")
    callee = create_user(db, "callee_user", "Callee")
    call = Call(caller_id=caller.id, callee_id=callee.id, call_type="video", status="ringing")
    db.add(call)
    db.commit()
    monkeypatch.setattr(global_presence_service, "publish", AsyncMock(return_value=1))
    monkeypatch.setattr(global_presence_service, "release_call_locks", AsyncMock(return_value=None))

    accepted = await CallService().accept(db, call.id, callee.id)
    late_reject = await CallService().reject(db, call.id, callee.id)

    db.refresh(call)
    assert accepted.status == "accepted"
    assert late_reject.status == "accepted"
    assert call.status == "accepted"
    assert call.end_reason is None
