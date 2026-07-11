from __future__ import annotations

import asyncio
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.core.security import decode_access_token
from app.db.session import SessionLocal
from app.models.user import User
from app.schemas.user_chat import ChatWebSocketEvent
from app.services.user_chat_service import chat_event, user_chat_service
from app.services.presence_service import presence_service


router = APIRouter(prefix="/messages", tags=["user-message-realtime"])
MAX_CHAT_SIGNAL_BYTES = 64 * 1024


async def forward_chat_events(websocket: WebSocket, user_id: str) -> None:
    local_queue = presence_service.subscribe_local(user_id)
    outbound_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=128)
    pubsub = None
    redis_task = None

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
        if pubsub is None:
            return
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
        local_task = asyncio.create_task(forward_local())
        if presence_service.configured:
            pubsub = presence_service.pubsub()
            await pubsub.subscribe(f"calls:user:{user_id}")
            redis_task = asyncio.create_task(forward_redis())
        while True:
            data = await outbound_queue.get()
            if isinstance(data, str) and len(data.encode("utf-8")) <= MAX_CHAT_SIGNAL_BYTES:
                await websocket.send_text(data)
    finally:
        presence_service.unsubscribe_local(user_id, local_queue)
        for task in (locals().get("local_task"), redis_task):
            if task:
                task.cancel()
        await asyncio.gather(*(task for task in (locals().get("local_task"), redis_task) if task), return_exceptions=True)
        if pubsub is not None:
            await pubsub.unsubscribe(f"calls:user:{user_id}")
            await pubsub.aclose()


async def send_error(websocket: WebSocket, user_id: str, detail: str, thread_id: str | None = None) -> None:
    await websocket.send_json(chat_event("error", user_id, {"detail": detail[:300]}, thread_id))


@router.websocket("/ws")
async def user_chat_socket(websocket: WebSocket, token: str = "") -> None:
    user_id = decode_access_token(token)
    if not user_id:
        await websocket.close(code=1008, reason="Invalid chat token.")
        return
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if not user or not user.is_active or (user.subscription_status or "").lower() in {"blocked", "suspended"}:
            await websocket.close(code=1008, reason="Inactive account.")
            return

    connection_id = str(uuid.uuid4())
    await websocket.accept()
    forward_task = asyncio.create_task(forward_chat_events(websocket, user_id))
    await websocket.send_json(chat_event("chat.ready", user_id, {"connection_id": connection_id}))
    with SessionLocal() as db:
        await user_chat_service.mark_pending_delivered_for_user(db, user_id)
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_CHAT_SIGNAL_BYTES:
                await websocket.close(code=1009, reason="Chat payload too large.")
                return
            try:
                event = ChatWebSocketEvent.model_validate_json(raw)
            except ValidationError:
                await send_error(websocket, user_id, "Invalid chat event.")
                continue
            try:
                with SessionLocal() as db:
                    if event.type == "ping":
                        await websocket.send_json(chat_event("pong", user_id, {"connection_id": connection_id}))
                    elif event.type == "message.send":
                        if not event.thread_id:
                            raise ValueError("Thread id is required.")
                        message = await user_chat_service.send_message(db, event.thread_id, db.get(User, user_id), event.payload)
                        serialized = user_chat_service.serialize_message(db, message, user_id).model_dump(mode="json")
                        await websocket.send_json(chat_event("message.sent_ack", user_id, {"message": serialized}, event.thread_id))
                    elif event.type == "message.delivered":
                        if not event.thread_id:
                            raise ValueError("Thread id is required.")
                        await user_chat_service.mark_delivered(db, event.thread_id, user_id)
                    elif event.type in {"message.read", "thread.open"}:
                        if not event.thread_id:
                            raise ValueError("Thread id is required.")
                        await user_chat_service.mark_read(db, event.thread_id, user_id)
                    elif event.type in {"typing.start", "typing.stop"}:
                        if not event.thread_id:
                            raise ValueError("Thread id is required.")
                        user_chat_service.participant(db, event.thread_id, user_id)
                        peer_id = user_chat_service.peer_id_for(db, event.thread_id, user_id)
                        peer_settings = user_chat_service.get_or_create_settings(db, user_id)
                        if peer_settings.typing_indicator_enabled:
                            await user_chat_service.publish(
                                peer_id,
                                chat_event(event.type, user_id, {"thread_id": event.thread_id, "user_id": user_id}, event.thread_id),
                            )
                    else:
                        raise ValueError("Unsupported chat event.")
            except Exception as exc:
                await send_error(websocket, user_id, str(exc), event.thread_id)
    except WebSocketDisconnect:
        return
    finally:
        forward_task.cancel()
        await asyncio.gather(forward_task, return_exceptions=True)
