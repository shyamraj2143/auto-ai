from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from fastapi import WebSocket
from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from app.models.call import UserDevice
from app.models.device_monitoring import UserDeviceActivity
from app.models.user import User
from app.schemas.device_monitoring import AdminDeviceSnapshotRead, AdminDeviceUserRead, DeviceActivityCreate, DeviceActivityRead, DeviceLocation
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service

logger = logging.getLogger("auto_ai.device_monitoring")

class DeviceActivityStream:
    def __init__(self) -> None:
        self._subscribers: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, user_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._subscribers.setdefault(user_id, set()).add(websocket)

    async def unsubscribe(self, user_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(user_id)
            if not subscribers:
                return
            subscribers.discard(websocket)
            if not subscribers:
                self._subscribers.pop(user_id, None)

    async def publish(self, activity: DeviceActivityRead) -> None:
        data = activity.model_dump(mode="json")
        payload = {
            "type": "device-update",
            "event": "device-update",
            "userId": activity.userId,
            "deviceId": activity.deviceId,
            "deviceType": activity.type,
            "data": data,
        }
        async with self._lock:
            subscribers = list(self._subscribers.get(activity.userId, set()))
        stale: list[WebSocket] = []
        for websocket in subscribers:
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        if stale:
            async with self._lock:
                current = self._subscribers.get(activity.userId)
                if current:
                    for websocket in stale:
                        current.discard(websocket)


device_activity_stream = DeviceActivityStream()


def ensure_device_snapshots(db: Session, user_id: str) -> dict[str, list[AdminDeviceSnapshotRead]]:
    return latest_device_snapshots(db, user_id)


def activity_to_read(activity: UserDeviceActivity) -> DeviceActivityRead:
    location = None
    if activity.latitude is not None or activity.longitude is not None:
        location = DeviceLocation(lat=activity.latitude, lng=activity.longitude)
    return DeviceActivityRead(
        id=activity.id,
        userId=activity.user_id,
        deviceId=activity.device_id or f"legacy-{activity.user_id}",
        type=activity.device_type or "mobile",
        timestamp=activity.timestamp,
        battery=activity.battery,
        screenOn=activity.screen_on,
        currentApp=activity.current_app,
        location=location,
        network=activity.network,
        storageTotal=activity.storage_total,
        storageUsed=activity.storage_used,
        storageFree=activity.storage_free,
        ramTotal=activity.ram_total,
        ramUsed=activity.ram_used,
        ramUsage=activity.ram_usage,
        deviceModel=activity.device_model,
        osVersion=activity.os_version,
        isActive=activity.is_active,
    )


def create_activity(db: Session, user: User, payload: DeviceActivityCreate) -> DeviceActivityRead:
    location = payload.location or DeviceLocation()
    device_id = payload.deviceId or f"mobile-{user.id}"
    activity = UserDeviceActivity(
        user_id=user.id,
        device_id=device_id,
        device_type=payload.type,
        timestamp=payload.timestamp or datetime.utcnow(),
        battery=payload.battery,
        screen_on=payload.screenOn,
        current_app=payload.currentApp,
        latitude=location.lat,
        longitude=location.lng,
        network=payload.network,
        storage_total=payload.storageTotal,
        storage_used=payload.storageUsed,
        storage_free=payload.storageFree,
        ram_total=payload.ramTotal,
        ram_used=payload.ramUsed,
        ram_usage=payload.ramUsage,
        device_model=payload.deviceModel,
        os_version=payload.osVersion,
        is_active=payload.isActive,
    )
    user.updated_at = datetime.utcnow()
    db.add(activity)
    db.commit()
    db.refresh(activity)
    return activity_to_read(activity)


def device_snapshot(activity: UserDeviceActivity, online_cutoff: datetime) -> AdminDeviceSnapshotRead:
    location = None
    if activity.latitude is not None or activity.longitude is not None:
        location = DeviceLocation(lat=activity.latitude, lng=activity.longitude)
    device_type = activity.device_type if activity.device_type in {"mobile", "laptop"} else "mobile"
    return AdminDeviceSnapshotRead(
        deviceId=activity.device_id or f"legacy-{activity.user_id}",
        deviceName=activity.device_model or ("Mobile device" if device_type == "mobile" else "Laptop/Desktop"),
        type=device_type,
        osVersion=activity.os_version,
        battery=activity.battery,
        storageTotal=activity.storage_total,
        storageUsed=activity.storage_used,
        ramTotal=activity.ram_total,
        ramUsed=activity.ram_used,
        network=activity.network,
        currentApp=activity.current_app,
        screenOn=activity.screen_on,
        lastActive=activity.timestamp,
        location=location,
        status="online" if activity.timestamp >= online_cutoff and activity.is_active else "offline",
    )


def latest_device_snapshots(db: Session, user_id: str, limit: int = 500) -> dict[str, list[AdminDeviceSnapshotRead]]:
    rows = db.scalars(
        select(UserDeviceActivity)
        .where(UserDeviceActivity.user_id == user_id)
        .order_by(desc(UserDeviceActivity.timestamp))
        .limit(max(1, min(limit, 1000)))
    ).all()
    seen: set[str] = set()
    online_cutoff = datetime.utcnow() - timedelta(seconds=10)
    result: dict[str, list[AdminDeviceSnapshotRead]] = {"mobile": [], "laptop": []}
    for row in rows:
        device_id = row.device_id or f"legacy-{row.user_id}"
        if device_id in seen:
            continue
        seen.add(device_id)
        snapshot = device_snapshot(row, online_cutoff)
        result[snapshot.type].append(snapshot)
    return result


def latest_activities(db: Session, user_id: str, limit: int = 100) -> list[DeviceActivityRead]:
    rows = db.scalars(
        select(UserDeviceActivity)
        .where(UserDeviceActivity.user_id == user_id)
        .order_by(desc(UserDeviceActivity.timestamp))
        .limit(max(1, min(limit, 500)))
    ).all()
    return [activity_to_read(row) for row in rows]


def clean_old_activities(db: Session, user_id: str) -> int:
    cutoff = datetime.utcnow() - timedelta(hours=24)
    result = db.execute(
        delete(UserDeviceActivity).where(
            UserDeviceActivity.user_id == user_id,
            UserDeviceActivity.timestamp < cutoff,
        )
    )
    db.commit()
    return int(result.rowcount or 0)


def list_device_users(db: Session) -> list[AdminDeviceUserRead]:
    users = db.scalars(select(User).order_by(User.created_at.desc())).all()
    result: list[AdminDeviceUserRead] = []
    online_cutoff = datetime.utcnow() - timedelta(seconds=10)
    for user in users:
        activity = db.scalar(
            select(UserDeviceActivity)
            .where(UserDeviceActivity.user_id == user.id)
            .order_by(desc(UserDeviceActivity.timestamp))
            .limit(1)
        )
        result.append(
            AdminDeviceUserRead(
                userId=user.id,
                name=user.name,
                email=user.email,
                deviceModel=activity.device_model if activity else None,
                osVersion=activity.os_version if activity else None,
                lastActive=activity.timestamp if activity else None,
                online=bool(activity and activity.timestamp >= online_cutoff and activity.is_active),
            )
        )
    return result


def send_device_command(db: Session, user_id: str, command_type: str, title: str, body: str, device_id: str | None = None) -> tuple[int, int]:
    query = select(UserDevice).where(
        UserDevice.user_id == user_id,
        UserDevice.platform == "android",
        UserDevice.is_active == True,  # noqa: E712
    )
    if device_id:
        query = query.where(UserDevice.device_id == device_id[:128])
    devices = db.scalars(query).all()
    sent = 0
    failed = 0
    for device in devices:
        token = decrypt_token(device.fcm_token_ciphertext, device.fcm_token)
        if not token:
            failed += 1
            device.is_active = False
            device.updated_at = datetime.utcnow()
            continue
        result = firebase_notification_service.send_device_command(
            token,
            command_type=command_type,
            user_id=user_id,
            title=title,
            body=body,
        )
        if result.ok:
            sent += 1
        else:
            failed += 1
            if result.inactive:
                device.is_active = False
                device.fcm_token = None
                device.fcm_token_ciphertext = None
                device.fcm_token_hash = None
                device.updated_at = datetime.utcnow()
    db.commit()
    logger.info("device_command type=%s user_id=%s sent=%d failed=%d", command_type, user_id, sent, failed)
    return sent, failed
