from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.call import UserDevice
from app.models.user import User
from app.schemas.device_monitoring import DeviceRegisterRequest
from app.services.device_token_security import encrypt_token, token_hash


def utc_now_naive() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def normalize_platform(value: str | None) -> str:
    platform = (value or "android").strip().lower()
    if platform in {"desktop", "windows", "macos", "linux", "electron"}:
        return "desktop"
    if platform in {"android", "ios", "web"}:
        return platform
    return "android"


def safe_permission_status(value: dict[str, bool] | None) -> str | None:
    if value is None:
        return None
    notification_allowed = bool(value.get("notification") or value.get("notifications"))
    return json.dumps({"notification": notification_allowed}, separators=(",", ":"))


def upsert_registered_device(db: Session, user: User, payload: DeviceRegisterRequest) -> UserDevice:
    now = payload.lastSeenAt or utc_now_naive()
    device_id = payload.deviceId[:128]
    record = db.scalar(select(UserDevice).where(UserDevice.user_id == user.id, UserDevice.device_id == device_id))
    next_token_hash = token_hash(payload.fcmToken)
    next_fid_hash = token_hash(payload.firebaseInstallationId)
    fid_record = db.scalar(select(UserDevice).where(UserDevice.firebase_installation_id_hash == next_fid_hash)) if next_fid_hash else None
    if fid_record is not None and fid_record is not record and fid_record.device_id != device_id:
        raise ValueError("DUPLICATE_FIREBASE_INSTALLATION")
    token_record = db.scalar(select(UserDevice).where(UserDevice.fcm_token_hash == next_token_hash)) if next_token_hash else None
    if token_record is not None and token_record is not record:
        token_record.is_active = False
        token_record.fcm_token = None
        token_record.fcm_token_ciphertext = None
        token_record.fcm_token_hash = None
        token_record.updated_at = now
    if not record:
        record = UserDevice(user_id=user.id, device_id=device_id)
        db.add(record)
    if payload.legacyDeviceId and payload.legacyDeviceId != device_id:
        legacy = db.scalar(select(UserDevice).where(UserDevice.user_id == user.id, UserDevice.device_id == payload.legacyDeviceId[:128]))
        if legacy is not None and legacy is not record:
            legacy.is_active = False
            legacy.fcm_token = None
            legacy.fcm_token_ciphertext = None
            legacy.fcm_token_hash = None
            legacy.updated_at = now
        record.legacy_device_id = payload.legacyDeviceId[:128]
    record.platform = normalize_platform(payload.platform)
    record.device_name = payload.deviceName
    record.manufacturer = payload.manufacturer
    record.model = payload.model
    record.android_sdk = payload.androidSdk
    record.os_version = payload.osVersion
    record.app_version = payload.appVersion
    record.app_version_code = payload.appVersionCode
    record.fcm_token = None
    record.fcm_token_ciphertext = encrypt_token(payload.fcmToken)
    record.fcm_token_hash = next_token_hash
    record.firebase_installation_id_ciphertext = encrypt_token(payload.firebaseInstallationId)
    record.firebase_installation_id_hash = next_fid_hash
    record.installation_rotation_status = "INSTALLATION_READY"
    record.push_provider = payload.pushProvider or "fcm"
    if payload.permissionsStatus is not None:
        record.permissions_status = safe_permission_status(payload.permissionsStatus)
    record.is_active = True
    record.status = "online"
    record.last_registered_at = now
    record.last_seen_at = now
    record.updated_at = now
    if payload.rotatingFromFirebaseInstallationHash:
        old_record = db.scalar(select(UserDevice).where(
            UserDevice.user_id == user.id,
            UserDevice.firebase_installation_id_hash.like(payload.rotatingFromFirebaseInstallationHash + "%"),
            UserDevice.id != record.id,
        ))
        if old_record is not None:
            old_record.is_active = False
            old_record.installation_rotation_status = "INSTALLATION_ROTATION_PENDING"
            old_record.updated_at = now
    db.commit()
    db.refresh(record)
    return record
