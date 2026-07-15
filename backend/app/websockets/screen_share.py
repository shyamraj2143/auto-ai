from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.screen_share import ScreenShareSignalEvent
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.screen_share_service import screen_share_event, screen_share_service


router = APIRouter(prefix="/screen-share", tags=["screen-share-signaling"])
MAX_SIGNAL_BYTES = 64 * 1024
WEBRTC_EVENTS = {"offer", "answer", "ice-candidate"}
SESSION_EVENTS = {
    "join-session",
    "screen-share-started",
    "screen-share-ended",
    "screen-share-declined",
    "screen-share-paused",
    "screen-share-resumed",
}


def error_event(user_id: str, detail: str, session_id: str | None = None) -> dict[str, Any]:
    return screen_share_event("screen-share-error", sender_user_id=user_id, session_id=session_id, payload={"detail": detail[:300]})


def validate_webrtc_payload(event: ScreenShareSignalEvent) -> dict[str, Any]:
    payload = event.payload
    if event.type in {"offer", "answer"}:
        description_type = payload.get("type")
        sdp = payload.get("sdp")
        expected = "offer" if event.type == "offer" else "answer"
        if description_type != expected or not isinstance(sdp, str) or not sdp or len(sdp) > 48_000:
            raise ValueError("Invalid WebRTC session description.")
        return {"type": expected, "sdp": sdp}
    if event.type == "ice-candidate":
        candidate = payload.get("candidate")
        if not isinstance(candidate, str) or len(candidate) > 4096:
            raise ValueError("Invalid ICE candidate.")
        sdp_mid = payload.get("sdpMid")
        line_index = payload.get("sdpMLineIndex")
        if sdp_mid is not None and (not isinstance(sdp_mid, str) or len(sdp_mid) > 64):
            raise ValueError("Invalid ICE media id.")
        if line_index is not None and (not isinstance(line_index, int) or line_index < 0 or line_index > 128):
            raise ValueError("Invalid ICE media line.")
        return {"candidate": candidate, "sdpMid": sdp_mid, "sdpMLineIndex": line_index}
    return {}


async def forward_screen_share_events(websocket: WebSocket, user_id: str, ready: asyncio.Event) -> None:
    pubsub = presence_service.pubsub()
    local_queue = presence_service.subscribe_local(user_id)
    outbound_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128)
    subscribed = False

    async def enqueue(data: str) -> None:
        try:
            outbound_queue.put_nowait(data)
        except asyncio.QueueFull:
            try:
                outbound_queue.get_nowait()
                outbound_queue.put_nowait(data)
            except asyncio.QueueEmpty:
                return

    async def forward_local() -> None:
        while True:
            await enqueue(await local_queue.get())

    async def forward_redis() -> None:
        while True:
            message = await pubsub.get_message(timeout=20.0)
            if not message:
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="ignore")
            if isinstance(data, str):
                await enqueue(data)

    try:
        await pubsub.subscribe(f"calls:user:{user_id}")
        subscribed = True
        ready.set()
        local_task = asyncio.create_task(forward_local())
        redis_task = asyncio.create_task(forward_redis())
        seen_event_ids: list[str] = []
        while True:
            data = await outbound_queue.get()
            if isinstance(data, str) and len(data.encode("utf-8")) <= MAX_SIGNAL_BYTES:
                try:
                    event = json.loads(data)
                    event_type = str(event.get("type") or "")
                    event_id = str(event.get("event_id") or "")
                except (TypeError, ValueError):
                    continue
                if not (
                    event_type.startswith("screen-share")
                    or event_type in {"join-session", "offer", "answer", "ice-candidate", "pong"}
                ):
                    continue
                if event_id:
                    if event_id in seen_event_ids:
                        continue
                    seen_event_ids.append(event_id)
                    if len(seen_event_ids) > 256:
                        seen_event_ids.pop(0)
                await websocket.send_text(data)
    finally:
        if not ready.is_set():
            ready.set()
        presence_service.unsubscribe_local(user_id, local_queue)
        for task in (locals().get("local_task"), locals().get("redis_task")):
            if task:
                task.cancel()
        await asyncio.gather(
            *(task for task in (locals().get("local_task"), locals().get("redis_task")) if task),
            return_exceptions=True,
        )
        if subscribed:
            await pubsub.unsubscribe(f"calls:user:{user_id}")
        await pubsub.aclose()


async def publish_to_session(session, event_type: str, sender_user_id: str, payload: dict[str, Any] | None = None) -> None:
    event = screen_share_event(event_type, sender_user_id=sender_user_id, session_id=session.session_id, payload=payload or {})
    recipients = {session.sharer_user_id, session.viewer_user_id} - {None}
    await asyncio.gather(*(presence_service.publish(str(user_id), event) for user_id in recipients), return_exceptions=True)


async def handle_signal(websocket: WebSocket, user_id: str, connection_id: str, event: ScreenShareSignalEvent) -> None:
    if event.sender_user_id and event.sender_user_id != user_id:
        raise ValueError("Sender does not match the authenticated user.")
    if not await presence_service.claim_event(user_id, event.event_id):
        return
    if not await presence_service.allow_rate("screen_share_signal", user_id, settings.CALL_SIGNAL_MAX_PER_MINUTE):
        raise ValueError("Signaling rate limit exceeded.")
    if event.type == "ping":
        await websocket.send_json(
            screen_share_event("pong", sender_user_id=user_id, payload={"connection_id": connection_id})
        )
        return
    if not event.session_id:
        raise ValueError("Session id is required.")

    with SessionLocal() as db:
        session = screen_share_service.get_authorized(
            db,
            event.session_id,
            user_id,
            invite_token=str(event.payload.get("inviteToken") or "") or None,
            allow_claim=event.type == "join-session",
        )
        if session.status in {"ended", "failed"} and event.type != "screen-share-ended":
            raise HTTPException(status_code=409, detail="Screen share session has ended.")
        if event.type == "join-session":
            await publish_to_session(
                session,
                "join-session",
                user_id,
                {
                    "sessionId": session.session_id,
                    "userId": user_id,
                    "role": "sharer" if user_id == session.sharer_user_id else "viewer",
                },
            )
            return
        if event.type == "screen-share-started":
            if user_id != session.sharer_user_id:
                raise HTTPException(status_code=403, detail="Only the sharer can start this session.")
            session = screen_share_service.mark_started(db, session)
            await publish_to_session(session, "screen-share-started", user_id, {"status": session.status})
            return
        if event.type == "screen-share-ended":
            session = screen_share_service.end(db, session.session_id, user_id)
            await publish_to_session(session, "screen-share-ended", user_id, {"status": session.status})
            return
        if event.type == "screen-share-declined":
            if user_id == session.sharer_user_id:
                raise HTTPException(status_code=403, detail="Only the viewer can decline this session.")
            session = screen_share_service.end(db, session.session_id, user_id)
            await publish_to_session(session, "screen-share-declined", user_id, {"status": session.status})
            return
        if event.type in {"screen-share-paused", "screen-share-resumed"}:
            if user_id != session.sharer_user_id:
                raise HTTPException(status_code=403, detail="Only the sharer can pause this session.")
            await publish_to_session(session, event.type, user_id, {})
            return
        if event.type in WEBRTC_EVENTS:
            if event.type == "ice-candidate" and not await presence_service.count_ice_candidate(session.session_id, user_id):
                raise ValueError("ICE candidate limit exceeded.")
            payload = validate_webrtc_payload(event)
            recipient_id = screen_share_service.peer_id_for(session, user_id)
            await presence_service.publish(
                recipient_id,
                {
                    "schema_version": 1,
                    "event_id": event.event_id,
                    "type": event.type,
                    "session_id": session.session_id,
                    "sender_user_id": user_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": payload,
                },
            )
            return
    raise ValueError("Unsupported signaling event.")


@router.websocket("/ws")
async def screen_share_socket(websocket: WebSocket, ticket: str = "") -> None:
    user_id = await presence_service.consume_ticket(ticket)
    if not user_id:
        await websocket.close(code=1008, reason="Invalid or expired realtime ticket.")
        return
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user or not user.is_active or (user.subscription_status or "").lower() in {"blocked", "suspended"}:
            await websocket.close(code=1008, reason="Inactive account.")
            return

    connection_id = str(uuid.uuid4())
    await websocket.accept()
    try:
        await presence_service.register_connection(user_id, connection_id)
    except RealtimeUnavailable:
        await websocket.close(code=1013, reason="Realtime service unavailable.")
        return
    subscription_ready = asyncio.Event()
    forward_task = asyncio.create_task(forward_screen_share_events(websocket, user_id, subscription_ready))
    await subscription_ready.wait()
    if forward_task.done():
        await websocket.close(code=1013, reason="Realtime subscription unavailable.")
        await presence_service.unregister_connection(user_id, connection_id)
        return
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_SIGNAL_BYTES:
                await websocket.close(code=1009, reason="Signaling payload too large.")
                break
            try:
                event = ScreenShareSignalEvent.model_validate_json(raw)
                await handle_signal(websocket, user_id, connection_id, event)
            except (ValidationError, ValueError) as exc:
                await websocket.send_json(error_event(user_id, str(exc)))
            except HTTPException as exc:
                await websocket.send_json(error_event(user_id, str(exc.detail), event.session_id))
            except RealtimeUnavailable as exc:
                await websocket.send_json(error_event(user_id, str(exc), event.session_id))
    except WebSocketDisconnect:
        pass
    finally:
        forward_task.cancel()
        await asyncio.gather(forward_task, return_exceptions=True)
        await presence_service.unregister_connection(user_id, connection_id)
