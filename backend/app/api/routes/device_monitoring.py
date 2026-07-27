import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.device_monitoring import DeviceActivityCreate, DeviceActivityIngestResponse, DeviceCommandAckRequest, DeviceHeartbeatRequest, DeviceRegisterRequest, DeviceRegisterResponse
from app.services.device_monitoring import upsert_registered_device
from app.services.device_token_security import token_hash


router = APIRouter(tags=["device-monitoring"])
logger = logging.getLogger("auto_ai.device_monitoring")


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
    try:
        device = upsert_registered_device(db, current_user, payload)
    except ValueError as exc:
        db.rollback()
        code = str(exc)
        if code in {"DUPLICATE_FIREBASE_INSTALLATION", "RESTORED_FIREBASE_INSTALLATION", "TOKEN_REPLACED_BY_OTHER_DEVICE"}:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": code}) from exc
        raise
    return DeviceRegisterResponse(
        deviceId=device.device_id,
        activation_required=False,
        approved=True,
        fcmTokenStored=bool(device.fcm_token_hash),
        fcmTokenHash=token_hash(payload.fcmToken)[:16] if payload.fcmToken else None,
    )


@router.post("/devices/heartbeat", response_model=DeviceActivityIngestResponse)
async def heartbeat_device(
    payload: DeviceHeartbeatRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceActivityIngestResponse:
    del db
    require_self_user(current_user, payload.userId)
    logger.info("deprecated_device_heartbeat_noop user_id=%s device_id=%s", current_user.id, payload.deviceId)
    return DeviceActivityIngestResponse(id=f"deprecated-{uuid.uuid4()}", activation_required=False, approved=True)


@router.post("/devices/commands/{command_id}/ack")
def acknowledge_command(
    command_id: str,
    payload: DeviceCommandAckRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str | bool]:
    del command_id, payload, current_user, db
    return {"success": True, "deprecated": True, "status": "disabled"}


@router.post("/device/activity", response_model=DeviceActivityIngestResponse)
@router.post("/devices/activity", response_model=DeviceActivityIngestResponse)
async def ingest_device_activity(
    payload: DeviceActivityCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DeviceActivityIngestResponse:
    del db
    logger.info("deprecated_device_activity_noop user_id=%s device_id=%s", current_user.id, payload.deviceId)
    return DeviceActivityIngestResponse(id=f"deprecated-{uuid.uuid4()}", activation_required=False, approved=True)


@router.get("/devices/activation-status")
@router.get("/devices/activation-status/{device_id}")
@router.get("/device/activation-status")
@router.get("/device/activation-status/{device_id}")
def deprecated_activation_status(device_id: str | None = None, _: User = Depends(get_current_user)) -> dict[str, bool | str | None]:
    logger.info("deprecated_activation_status_noop device_id=%s", device_id)
    return {
        "success": True,
        "deprecated": True,
        "deviceId": device_id,
        "activation_required": False,
        "approved": True,
        "is_device_active": True,
    }


@router.post("/devices/activation-request")
@router.post("/device/activation-request")
def deprecated_activation_request(_: DeviceRegisterRequest, current_user: User = Depends(get_current_user)) -> dict[str, bool | str]:
    logger.info("deprecated_activation_request_noop user_id=%s", current_user.id)
    return {
        "success": True,
        "deprecated": True,
        "activation_required": False,
        "approved": True,
    }
