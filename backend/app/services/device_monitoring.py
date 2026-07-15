from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timedelta

from fastapi import WebSocket
from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.call import UserDevice
from app.models.device_monitoring import UserDeviceActivity
from app.models.user import User
from app.schemas.device_monitoring import AdminDeviceSnapshotRead, AdminDeviceUserRead, DeviceActivityCreate, DeviceActivityRead, DeviceLocation
from app.services.device_token_security import decrypt_token
from app.services.firebase_notifications import firebase_notification_service

logger = logging.getLogger("auto_ai.device_monitoring")

MOBILE_NAMES = [
    "Samsung Galaxy S23 Ultra",
    "iPhone 15 Pro",
    "Google Pixel 8 Pro",
    "OnePlus 12",
    "Xiaomi 14 Pro",
]
LAPTOP_NAMES = [
    "Dell XPS 15",
    "MacBook Pro 14",
    "HP Spectre x360",
    "Lenovo ThinkPad X1",
]
MOBILE_APPS = ["WhatsApp", "Instagram", "Chrome", "YouTube", "Auto-AI", "Google Maps", "Telegram"]
LAPTOP_APPS = ["VS Code", "Chrome", "Auto-AI Desktop", "Terminal", "Slack", "Figma", "PyCharm"]
NETWORKS = ["WiFi", "5G", "4G", "Ethernet"]


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


def random_delhi_location() -> tuple[float, float]:
    return (
        round(28.6139 + random.uniform(-0.045, 0.045), 6),
        round(77.2090 + random.uniform(-0.045, 0.045), 6),
    )


def gb(value: float) -> str:
    return f"{value:.1f} GB"


def generate_mock_devices(db: Session, user_id: str) -> list[DeviceActivityRead]:
    created: list[DeviceActivityRead] = []
    mobile_count = random.randint(2, 4)
    laptop_count = random.randint(1, 2)
    now = datetime.utcnow()
    for index, name in enumerate(random.sample(MOBILE_NAMES, mobile_count), start=1):
        total_storage = random.choice([128, 256, 512])
        used_storage = random.uniform(total_storage * 0.25, total_storage * 0.82)
        total_ram = random.choice([6, 8, 12])
        used_ram = random.uniform(total_ram * 0.25, total_ram * 0.75)
        lat, lng = random_delhi_location()
        row = UserDeviceActivity(
            user_id=user_id,
            device_id=f"mock-mobile-{user_id[:8]}-{index}",
            device_type="mobile",
            timestamp=now,
            battery=random.randint(50, 98),
            screen_on=True,
            current_app=random.choice(MOBILE_APPS),
            latitude=lat,
            longitude=lng,
            network=random.choice(["WiFi", "5G", "4G"]),
            storage_total=gb(total_storage),
            storage_used=gb(used_storage),
            storage_free=gb(max(0, total_storage - used_storage)),
            ram_total=gb(total_ram),
            ram_used=gb(used_ram),
            ram_usage=f"{gb(used_ram)} / {gb(total_ram)}",
            device_model=name,
            os_version=random.choice(["Android 14", "Android 15", "iOS 18"]),
            is_active=True,
        )
        db.add(row)
        db.flush()
        created.append(activity_to_read(row))
    for index, name in enumerate(random.sample(LAPTOP_NAMES, laptop_count), start=1):
        total_storage = random.choice([512, 1024, 2048])
        used_storage = random.uniform(total_storage * 0.18, total_storage * 0.78)
        total_ram = random.choice([16, 24, 32])
        used_ram = random.uniform(total_ram * 0.2, total_ram * 0.72)
        lat, lng = random_delhi_location()
        row = UserDeviceActivity(
            user_id=user_id,
            device_id=f"mock-laptop-{user_id[:8]}-{index}",
            device_type="laptop",
            timestamp=now,
            battery=random.randint(50, 98),
            screen_on=True,
            current_app=random.choice(LAPTOP_APPS),
            latitude=lat,
            longitude=lng,
            network=random.choice(["WiFi", "Ethernet"]),
            storage_total=gb(total_storage),
            storage_used=gb(used_storage),
            storage_free=gb(max(0, total_storage - used_storage)),
            ram_total=gb(total_ram),
            ram_used=gb(used_ram),
            ram_usage=f"{gb(used_ram)} / {gb(total_ram)}",
            device_model=name,
            os_version=random.choice(["Windows 11 Pro", "macOS Sonoma", "Ubuntu 24.04"]),
            is_active=True,
        )
        db.add(row)
        db.flush()
        created.append(activity_to_read(row))
    db.commit()
    logger.info("mock_devices_generated user_id=%s count=%d", user_id, len(created))
    return created


def ensure_device_snapshots(db: Session, user_id: str) -> dict[str, list[AdminDeviceSnapshotRead]]:
    snapshots = latest_device_snapshots(db, user_id)
    if snapshots["mobile"] or snapshots["laptop"]:
        return snapshots
    generate_mock_devices(db, user_id)
    return latest_device_snapshots(db, user_id)


def _float_gb(value: str | None, fallback: float) -> float:
    if not value:
        return fallback
    try:
        return float(value.split()[0])
    except (ValueError, IndexError):
        return fallback


def _next_mock_row(row: UserDeviceActivity) -> UserDeviceActivity:
    total_storage = _float_gb(row.storage_total, 256 if row.device_type == "mobile" else 1024)
    used_storage = max(1, min(total_storage * 0.96, _float_gb(row.storage_used, total_storage * 0.5) + random.uniform(-1.2, 1.8)))
    total_ram = _float_gb(row.ram_total, 8 if row.device_type == "mobile" else 16)
    used_ram = max(0.5, min(total_ram * 0.96, _float_gb(row.ram_used, total_ram * 0.45) + random.uniform(-0.35, 0.5)))
    lat, lng = random_delhi_location()
    apps = MOBILE_APPS if row.device_type == "mobile" else LAPTOP_APPS
    networks = ["WiFi", "5G", "4G"] if row.device_type == "mobile" else ["WiFi", "Ethernet"]
    return UserDeviceActivity(
        user_id=row.user_id,
        device_id=row.device_id,
        device_type=row.device_type,
        timestamp=datetime.utcnow(),
        battery=max(10, min(98, int((row.battery or 75) + random.uniform(-2, 2)))),
        screen_on=random.random() > 0.2,
        current_app=random.choice(apps),
        latitude=lat,
        longitude=lng,
        network=random.choice(networks),
        storage_total=gb(total_storage),
        storage_used=gb(used_storage),
        storage_free=gb(max(0, total_storage - used_storage)),
        ram_total=gb(total_ram),
        ram_used=gb(used_ram),
        ram_usage=f"{gb(used_ram)} / {gb(total_ram)}",
        device_model=row.device_model,
        os_version=row.os_version,
        is_active=True,
    )


async def update_mock_devices_once() -> int:
    with SessionLocal() as db:
        rows = db.scalars(
            select(UserDeviceActivity)
            .where(UserDeviceActivity.device_id.like("mock-%"), UserDeviceActivity.is_active.is_(True))
            .order_by(desc(UserDeviceActivity.timestamp))
            .limit(1000)
        ).all()
        latest: dict[str, UserDeviceActivity] = {}
        for row in rows:
            if row.device_id and row.device_id not in latest:
                latest[row.device_id] = row
        next_rows = [_next_mock_row(row) for row in latest.values()]
        for row in next_rows:
            db.add(row)
        db.commit()
        reads = [activity_to_read(row) for row in next_rows]
    for read in reads:
        await device_activity_stream.publish(read)
    return len(reads)


async def mock_device_updater_loop(stop_event: asyncio.Event) -> None:
    while not stop_event.is_set():
        try:
            count = await update_mock_devices_once()
            if count:
                logger.debug("mock_device_updates count=%d", count)
        except Exception:
            logger.exception("mock_device_update_failed")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=1)
        except asyncio.TimeoutError:
            pass


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
