from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.call import SignalEvent
from app.services.call_service import call_service, signal_event
from app.services.presence_service import RealtimeUnavailable, presence_service


router = APIRouter(prefix="/calls", tags=["call-signaling"])
MAX_SIGNAL_BYTES = 64 * 1024
ALLOWED_PRESENCE_STATES = {"online", "away", "background"}
WEBRTC_EVENTS = {
    "webrtc.offer",
    "webrtc.answer",
    "webrtc.ice_candidate",
    "webrtc.renegotiate",
    "webrtc.ice_restart",
}


def error_event(user_id: str, detail: str, call_id: str | None = None) -> dict[str, Any]:
    return signal_event(
        "call.error", sender_user_id=user_id, call_id=call_id, payload={"detail": detail[:300]}
    )


def validate_webrtc_payload(event: SignalEvent) -> dict[str, Any]:
    payload = event.payload
    if event.type in {"webrtc.offer", "webrtc.answer"}:
        description_type = payload.get("type")
        sdp = payload.get("sdp")
        expected = "offer" if event.type == "webrtc.offer" else "answer"
        if description_type != expected or not isinstance(sdp, str) or not sdp or len(sdp) > 48_000:
            raise ValueError("Invalid WebRTC session description.")
        return {"type": expected, "sdp": sdp}
    if event.type == "webrtc.ice_candidate":
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
    if event.type in {"webrtc.renegotiate", "webrtc.ice_restart"}:
        return {"reason": str(payload.get("reason") or "network_change")[:64]}
    raise ValueError("Unsupported WebRTC event.")


async def forward_user_events(websocket: WebSocket, user_id: str, ready: asyncio.Event) -> None:
    pubsub = presence_service.pubsub()
    local_queue = presence_service.subscribe_local(user_id)
    outbound_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128)
    channel = f"calls:user:{user_id}"
    presence_channel = "calls:presence"
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
        await pubsub.subscribe(channel, presence_channel)
        subscribed = True
        ready.set()
        local_task = asyncio.create_task(forward_local())
        redis_task = asyncio.create_task(forward_redis())
        seen_event_ids: list[str] = []
        while True:
            data = await outbound_queue.get()
            if isinstance(data, str) and len(data.encode("utf-8")) <= MAX_SIGNAL_BYTES:
                try:
                    event_id = str(json.loads(data).get("event_id") or "")
                except (TypeError, ValueError):
                    event_id = ""
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
            await pubsub.unsubscribe(channel, presence_channel)
        await pubsub.aclose()


async def handle_signal(websocket: WebSocket, user_id: str, connection_id: str, event: SignalEvent) -> None:
    if event.sender_user_id and event.sender_user_id != user_id:
        raise ValueError("Sender does not match the authenticated user.")
    if not await presence_service.claim_event(user_id, event.event_id):
        return
    if not await presence_service.allow_rate(
        "signal", user_id, settings.CALL_SIGNAL_MAX_PER_MINUTE
    ):
        raise ValueError("Signaling rate limit exceeded.")

    if event.type == "ping":
        await websocket.send_json(
            signal_event("pong", sender_user_id=user_id, payload={"connection_id": connection_id})
        )
        return
    if event.type in {"presence.ready", "presence.heartbeat", "presence.status"}:
        requested_state = str(event.payload.get("state") or "online")
        if requested_state not in ALLOWED_PRESENCE_STATES:
            raise ValueError("Invalid presence state.")
        await presence_service.heartbeat(user_id, connection_id, requested_state)
        return
    if not event.call_id:
        raise ValueError("Call id is required for this event.")

    with SessionLocal() as db:
        if event.type == "call.ringing":
            await call_service.ringing(db, event.call_id, user_id)
            return
        if event.type == "call.accept":
            await call_service.accept(db, event.call_id, user_id)
            return
        if event.type == "call.reject":
            await call_service.reject(db, event.call_id, user_id)
            return
        if event.type == "call.cancel":
            await call_service.cancel(db, event.call_id, user_id)
            return
        if event.type == "call.end":
            await call_service.end(db, event.call_id, user_id, str(event.payload.get("end_reason") or ""))
            return
        if event.type == "call.connected":
            await call_service.connected(db, event.call_id, user_id)
            return
        if event.type == "call.media_state":
            _, recipient_id = await call_service.authorize_signaling(db, event.call_id, user_id, event.type)
            await presence_service.publish(
                recipient_id,
                {
                    "schema_version": 1,
                    "event_id": event.event_id,
                    "type": "call.media_state",
                    "call_id": event.call_id,
                    "sender_user_id": user_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": {
                        "camera_enabled": bool(event.payload.get("camera_enabled", False)),
                        "muted": bool(event.payload.get("muted", False)),
                    },
                },
            )
            return
        if event.type in {"call.peer_ready", "call.offer_received", "call.answer_applied", "call.media_ready"}:
            call, recipient_id = await call_service.authorize_signaling(db, event.call_id, user_id, event.type)
            safe_payload = {
                "call_type": str(event.payload.get("call_type") or call.call_type),
                "audio_ready": bool(event.payload.get("audio_ready", False)),
                "video_ready": bool(event.payload.get("video_ready", False)),
                "audio_only": bool(event.payload.get("audio_only", False)),
                "negotiation_id": str(event.payload.get("negotiation_id") or "")[:64],
                "revision": call.revision,
            }
            await presence_service.publish(
                recipient_id,
                signal_event(event.type, sender_user_id=user_id, call_id=call.id, payload=safe_payload),
            )
            return
        if event.type == "call.busy":
            await call_service.reject(db, event.call_id, user_id)
            return
        if event.type in WEBRTC_EVENTS:
            if event.type == "webrtc.ice_candidate" and not await presence_service.count_ice_candidate(
                event.call_id, user_id
            ):
                raise ValueError("ICE candidate limit exceeded.")
            payload = validate_webrtc_payload(event)
            _, recipient_id = await call_service.authorize_signaling(db, event.call_id, user_id, event.type)
            await presence_service.publish(
                recipient_id,
                {
                    "schema_version": 1,
                    "event_id": event.event_id,
                    "type": event.type,
                    "call_id": event.call_id,
                    "sender_user_id": user_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "payload": payload,
                },
            )
            return
    raise ValueError("Unsupported signaling event.")


@router.websocket("/ws")
async def call_signaling_socket(websocket: WebSocket, ticket: str = "") -> None:
    if not settings.CALL_FEATURE_ENABLED:
        await websocket.close(code=1008, reason="Calls are disabled.")
        return
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
    forward_task = asyncio.create_task(forward_user_events(websocket, user_id, subscription_ready))
    await subscription_ready.wait()
    if forward_task.done():
        await websocket.close(code=1013, reason="Realtime subscription unavailable.")
        await presence_service.unregister_connection(user_id, connection_id)
        return
    await websocket.send_json(
        signal_event(
            "presence.snapshot",
            sender_user_id=user_id,
            payload={"self": {"state": "online", "connection_id": connection_id}},
        )
    )
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_SIGNAL_BYTES:
                await websocket.close(code=1009, reason="Signaling payload too large.")
                break
            try:
                event = SignalEvent.model_validate_json(raw)
                await handle_signal(websocket, user_id, connection_id, event)
            except (ValidationError, ValueError) as exc:
                await websocket.send_json(error_event(user_id, str(exc)))
            except HTTPException as exc:
                await websocket.send_json(error_event(user_id, str(exc.detail), event.call_id))
            except RealtimeUnavailable as exc:
                await websocket.send_json(error_event(user_id, str(exc), event.call_id))
    except WebSocketDisconnect:
        pass
    finally:
        forward_task.cancel()
        await asyncio.gather(forward_task, return_exceptions=True)
        await presence_service.unregister_connection(user_id, connection_id)
