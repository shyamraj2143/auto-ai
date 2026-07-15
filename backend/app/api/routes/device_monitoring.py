import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.security import decode_access_token
from app.db.session import SessionLocal, get_db
from app.models.user import User
from app.schemas.device_monitoring import DeviceActivityCreate, DeviceActivityIngestResponse
from app.services.device_monitoring import create_activity, device_activity_stream


router = APIRouter(tags=["device-monitoring"])


@router.post("/device/activity", response_model=DeviceActivityIngestResponse)
async def ingest_device_activity(
    payload: DeviceActivityCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceActivityIngestResponse:
    activity = create_activity(db, current_user, payload)
    asyncio.create_task(device_activity_stream.publish(activity))
    return DeviceActivityIngestResponse(id=activity.id)


@router.websocket("/admin/device-stream")
async def admin_device_stream(websocket: WebSocket, token: str = Query(default=""), user_id: str = Query(default="")) -> None:
    if not token or not user_id:
        await websocket.close(code=4401, reason="Missing token or user_id")
        return
    subject = decode_access_token(token)
    if not subject:
        await websocket.close(code=4401, reason="Invalid token")
        return
    with SessionLocal() as db:
        user = db.get(User, subject)
        if not user or not user.is_active or not user.is_admin or user.role not in {"admin", "super_admin"}:
            await websocket.close(code=4403, reason="Admin access required")
            return
        target = db.get(User, user_id)
        if not target:
            await websocket.close(code=4404, reason="User not found")
            return
    await websocket.accept()
    await device_activity_stream.subscribe(user_id, websocket)
    try:
        await websocket.send_json({"type": "ready", "userId": user_id})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await device_activity_stream.unsubscribe(user_id, websocket)
