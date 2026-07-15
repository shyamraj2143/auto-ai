import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.security import decode_access_token
from app.db.session import SessionLocal, get_db
from app.models.user import User
from app.schemas.device_monitoring import DeviceActivityCreate, DeviceActivityIngestResponse, DeviceCommandAckRequest, DeviceHeartbeatRequest, DeviceRegisterRequest, DeviceRegisterResponse
from app.services.device_monitoring import acknowledge_device_command, create_activity, device_activity_stream, ensure_device_snapshots, heartbeat_device_activity, upsert_registered_device


router = APIRouter(tags=["device-monitoring"])


def resolve_user(db: Session, identifier: str) -> User | None:
    value = identifier.strip()
    user = db.get(User, value)
    if user:
        return user
    lowered = value.lower()
    return db.scalar(
        select(User).where(
            or_(
                func.lower(User.email) == lowered,
                User.mobile == value,
                User.username == value,
            )
        )
    )


def require_self_user(current_user: User, user_id: str | None) -> None:
    if user_id and user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cannot register or update another user's device.")


@router.post("/devices/register", response_model=DeviceRegisterResponse)
def register_device(
    payload: DeviceRegisterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceRegisterResponse:
    require_self_user(current_user, payload.userId)
    device = upsert_registered_device(db, current_user, payload)
    return DeviceRegisterResponse(deviceId=device.device_id)


@router.post("/devices/heartbeat", response_model=DeviceActivityIngestResponse)
async def heartbeat_device(
    payload: DeviceHeartbeatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceActivityIngestResponse:
    require_self_user(current_user, payload.userId)
    activity = heartbeat_device_activity(db, current_user, payload)
    asyncio.create_task(device_activity_stream.publish(activity))
    return DeviceActivityIngestResponse(id=activity.id)


@router.post("/devices/commands/{command_id}/ack")
def acknowledge_command(
    command_id: str,
    payload: DeviceCommandAckRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str | bool]:
    command = acknowledge_device_command(db, current_user, command_id, payload.deviceId, payload.status)
    if not command:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device command not found.")
    asyncio.create_task(device_activity_stream.publish_command(current_user.id, command.device_id, command.id, command.status))
    return {"success": True, "commandId": command.id, "status": command.status}


@router.post("/device/activity", response_model=DeviceActivityIngestResponse)
@router.post("/devices/activity", response_model=DeviceActivityIngestResponse)
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
        target = resolve_user(db, user_id)
        if not target:
            await websocket.close(code=4404, reason="User not found")
            return
        target_user_id = target.id
    await websocket.accept()
    await device_activity_stream.subscribe(target_user_id, websocket)
    try:
        with SessionLocal() as db:
            snapshots = ensure_device_snapshots(db, target_user_id)
        await websocket.send_json({"type": "ready", "userId": target_user_id, "requestedUserId": user_id})
        await websocket.send_json(
            {
                "type": "initial-data",
                "event": "device-telemetry",
                "userId": target_user_id,
                "data": {
                    "mobile": [item.model_dump(mode="json") for item in snapshots["mobile"]],
                    "laptop": [item.model_dump(mode="json") for item in snapshots["laptop"]],
                    "desktop": [item.model_dump(mode="json") for item in snapshots["laptop"]],
                },
            }
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await device_activity_stream.unsubscribe(target_user_id, websocket)
