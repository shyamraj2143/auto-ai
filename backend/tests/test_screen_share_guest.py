from datetime import datetime, timezone
from unittest.mock import AsyncMock

import fakeredis.aioredis
import pytest
from pydantic import EmailStr, TypeAdapter
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.api.routes import screen_share
from app.core.config import settings
from app.db.base import Base
from app.db.session import get_db
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.screen_share_service import GUEST_ID_PREFIX
from app.services.screen_share_service import ScreenShareActor, screen_share_service
from app.schemas.screen_share import ScreenShareSignalEvent
from app.websockets import screen_share as screen_share_signaling


def guest_test_app(test_sessions) -> FastAPI:
    app = FastAPI()

    def override_db():
        with test_sessions() as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    app.include_router(screen_share.router, prefix="/api/v1")
    return app


def test_guests_create_and_join_screen_share_without_login(monkeypatch) -> None:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    test_sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(presence_service, "allow_rate", AsyncMock(return_value=True))

    with TestClient(guest_test_app(test_sessions)) as client:
        assert client.post("/api/v1/screen-share/session", json={"code_mode": True}).status_code == 401

        sharer_token = client.post("/api/v1/screen-share/guest-token").json()["access_token"]
        viewer_token = client.post("/api/v1/screen-share/guest-token").json()["access_token"]
        third_token = client.post("/api/v1/screen-share/guest-token").json()["access_token"]

        created = client.post(
            "/api/v1/screen-share/session",
            headers={"Authorization": f"Bearer {sharer_token}"},
            json={"code_mode": True, "expires_minutes": 60},
        )
        assert created.status_code == 201
        created_body = created.json()
        assert len(created_body["shareCode"]) == 8
        assert created_body["shareCode"].isdigit()
        assert created_body["sharerUserId"].startswith(GUEST_ID_PREFIX)

        joined = client.post(
            "/api/v1/screen-share/session/join-code",
            headers={"Authorization": f"Bearer {viewer_token}"},
            json={"code": created_body["shareCode"]},
        )
        assert joined.status_code == 200
        assert joined.json()["viewerUserId"].startswith(GUEST_ID_PREFIX)

        conflict = client.post(
            "/api/v1/screen-share/session/join-code",
            headers={"Authorization": f"Bearer {third_token}"},
            json={"code": created_body["shareCode"]},
        )
        assert conflict.status_code == 409

        monkeypatch.setattr(presence_service, "publish", AsyncMock(side_effect=RealtimeUnavailable("offline")))
        ended = client.post(
            f"/api/v1/screen-share/session/{created_body['sessionId']}/end",
            headers={"Authorization": f"Bearer {sharer_token}"},
            json={},
        )
        assert ended.status_code == 200
        assert ended.json()["status"] == "ended"

    with test_sessions() as db:
        host = screen_share_service._guest_host_user(db)
        assert TypeAdapter(EmailStr).validate_python(host.email) == host.email


def test_guest_screen_share_websocket_accepts_realtime_ticket(monkeypatch) -> None:
    guest_identity = f"{GUEST_ID_PREFIX}11111111-1111-4111-8111-111111111111"
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake/0")
    monkeypatch.setattr(presence_service, "_redis", fake_redis)
    monkeypatch.setattr(presence_service, "consume_ticket", AsyncMock(return_value=guest_identity))

    app = FastAPI()
    app.include_router(screen_share_signaling.router)
    with TestClient(app) as client:
        with client.websocket_connect("/screen-share/ws?ticket=guest-ticket") as websocket:
            websocket.send_json(
                {
                    "schema_version": 1,
                    "event_id": "guest-ping-event",
                    "type": "ping",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": {},
                }
            )
            response = websocket.receive_json()
            assert response["type"] == "pong"
            assert response["sender_user_id"] == guest_identity


@pytest.mark.asyncio
async def test_guest_webrtc_offer_routes_only_to_claimed_viewer(monkeypatch) -> None:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    test_sessions = sessionmaker(bind=engine)
    sharer_id = f"{GUEST_ID_PREFIX}22222222-2222-4222-8222-222222222222"
    viewer_id = f"{GUEST_ID_PREFIX}33333333-3333-4333-8333-333333333333"
    with test_sessions() as db:
        session, _, code = screen_share_service.create(
            db,
            ScreenShareActor(sharer_id),
            viewer_user_id=None,
            invite_link=False,
            code_mode=True,
            expires_minutes=60,
        )
        screen_share_service.claim_by_code(db, viewer_id, code or "")
        session_id = session.session_id

    publish = AsyncMock(return_value=1)
    monkeypatch.setattr(screen_share_signaling, "SessionLocal", test_sessions)
    monkeypatch.setattr(presence_service, "claim_event", AsyncMock(return_value=True))
    monkeypatch.setattr(presence_service, "allow_rate", AsyncMock(return_value=True))
    monkeypatch.setattr(presence_service, "publish", publish)
    event = ScreenShareSignalEvent(
        event_id="guest-offer-event",
        type="offer",
        session_id=session_id,
        timestamp=datetime.now(timezone.utc),
        payload={"type": "offer", "sdp": "v=0\r\n"},
    )

    await screen_share_signaling.handle_signal(AsyncMock(), sharer_id, "connection-id", event)

    publish.assert_awaited_once()
    recipient_id, payload = publish.await_args.args
    assert recipient_id == viewer_id
    assert payload["type"] == "offer"
    assert payload["sender_user_id"] == sharer_id
