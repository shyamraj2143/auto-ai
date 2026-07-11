from datetime import datetime
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.call import BlockedUser, Call, CallReport, UserCallSettings, UserDevice
from app.models.user import User
from app.schemas.call import (
    BlockedUserRead,
    BlockRequest,
    CallActionRequest,
    CallCreateRequest,
    CallFeatureConfig,
    CallHealth,
    CallHistoryPage,
    CallRead,
    CallSettingsRead,
    CallSettingsUpdate,
    CallUserPage,
    DeviceRegisterRequest,
    DeviceRegisterResult,
    ReportRequest,
    TurnCredentials,
    WebSocketTicket,
)
from app.services.call_permission_service import call_allowed, get_or_create_call_settings
from app.services.call_service import base_public_user, call_service
from app.services.device_token_security import encrypt_token, token_hash
from app.services.firebase_notifications import firebase_notification_service
from app.services.presence_service import RealtimeUnavailable, presence_service
from app.services.turn_credentials_service import TURN_UNAVAILABLE_MESSAGE, create_turn_credentials


router = APIRouter(prefix="/calls", tags=["calls"])
logger = logging.getLogger("auto_ai.calls.api")


def discoverable_users_query(current_user_id: str):
    blocked = exists(
        select(BlockedUser.id).where(
            or_(
                and_(BlockedUser.blocker_id == current_user_id, BlockedUser.blocked_user_id == User.id),
                and_(BlockedUser.blocker_id == User.id, BlockedUser.blocked_user_id == current_user_id),
            )
        )
    )
    registered_device = exists(
        select(UserDevice.id).where(
            UserDevice.user_id == User.id,
            UserDevice.is_active == True,  # noqa: E712
        )
    )
    return (
        select(User, UserCallSettings)
        .join(UserCallSettings, UserCallSettings.user_id == User.id)
        .where(
            User.id != current_user_id,
            User.is_active == True,  # noqa: E712
            UserCallSettings.is_discoverable == True,  # noqa: E712
            User.username.is_not(None),
            User.username != "",
            User.name != "",
            registered_device,
            ~blocked,
        )
    )


async def public_search_result(db: Session, user: User, record: UserCallSettings, viewer_id: str):
    public = await call_service.public_user(db, user, viewer_id=viewer_id, settings_record=record)
    public.can_audio_call = public.presence != "busy" and call_allowed(db, viewer_id, user.id, "audio")[0]
    public.can_video_call = public.presence != "busy" and call_allowed(db, viewer_id, user.id, "video")[0]
    return public


@router.get("/config", response_model=CallFeatureConfig)
async def call_feature_config(current_user: User = Depends(get_current_user)) -> CallFeatureConfig:
    del current_user
    realtime_ready = await presence_service.check() if settings.CALL_FEATURE_ENABLED else False
    diagnostic = None
    if settings.CALL_FEATURE_ENABLED and not realtime_ready:
        diagnostic = "Realtime calling is temporarily unavailable."
    elif settings.is_production and not settings.turn_configured:
        diagnostic = TURN_UNAVAILABLE_MESSAGE
    return CallFeatureConfig(
        enabled=settings.CALL_FEATURE_ENABLED,
        realtime_configured=realtime_ready,
        turn_configured=settings.turn_configured,
        firebase_configured=firebase_notification_service.configured,
        ring_timeout_seconds=settings.CALL_RING_TIMEOUT_SECONDS,
        reconnect_grace_seconds=settings.CALL_RECONNECT_GRACE_SECONDS,
        diagnostic=diagnostic,
    )


@router.get("/health", response_model=CallHealth)
async def call_health() -> CallHealth:
    redis_configured = presence_service.configured
    redis_reachable = await presence_service.check() if redis_configured else False
    return CallHealth(
        calling_enabled=settings.CALL_FEATURE_ENABLED,
        redis_configured=redis_configured,
        redis_reachable=redis_reachable,
        websocket_ready=settings.CALL_FEATURE_ENABLED and redis_reachable,
    )


@router.get("/users", response_model=CallUserPage)
async def search_users(
    query: str = Query(default="", max_length=80),
    page: int = Query(default=1, ge=1, le=10000),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallUserPage:
    normalized = " ".join(query.strip().split())
    if len(normalized) == 1:
        return CallUserPage(items=[], page=page, limit=limit, has_more=False)
    try:
        allowed = await presence_service.allow_rate(
            "search", current_user.id, settings.CALL_SEARCH_MAX_PER_MINUTE
        )
    except RealtimeUnavailable:
        allowed = True
        logger.warning("call_user_search_rate_limit_unavailable redis_reachable=false")
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many user searches.")
    statement = discoverable_users_query(current_user.id)
    if normalized:
        escaped = normalized.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        statement = statement.where(
            or_(User.name.ilike(pattern, escape="\\"), User.username.ilike(pattern, escape="\\"))
        )
    statement = statement.order_by(User.name.asc(), User.id.asc()).offset((page - 1) * limit).limit(limit + 1)
    rows = list(db.execute(statement).all())
    items = [
        await public_search_result(db, user, record, current_user.id)
        for user, record in rows[:limit]
    ]
    return CallUserPage(items=items, page=page, limit=limit, has_more=len(rows) > limit)


@router.get("/users/online", response_model=CallUserPage)
async def online_users(
    page: int = Query(default=1, ge=1, le=10000),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallUserPage:
    scan_limit = min(250, max(limit * 5, 50))
    rows = list(
        db.execute(
            discoverable_users_query(current_user.id)
            .where(UserCallSettings.show_online_status == True)  # noqa: E712
            .order_by(User.updated_at.desc())
            .offset((page - 1) * scan_limit)
            .limit(scan_limit)
        ).all()
    )
    items = []
    for user, record in rows:
        public = await public_search_result(db, user, record, current_user.id)
        if public.presence in {"online", "away", "busy"}:
            items.append(public)
        if len(items) >= limit + 1:
            break
    return CallUserPage(items=items[:limit], page=page, limit=limit, has_more=len(items) > limit)


@router.get("/settings", response_model=CallSettingsRead)
def get_call_settings(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
) -> UserCallSettings:
    record = get_or_create_call_settings(db, current_user.id)
    db.commit()
    db.refresh(record)
    return record


@router.patch("/settings", response_model=CallSettingsRead)
def update_call_settings(
    payload: CallSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> UserCallSettings:
    record = get_or_create_call_settings(db, current_user.id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(record, key, value)
    record.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(record)
    return record


@router.post("/devices/register", response_model=DeviceRegisterResult)
def register_call_device(
    payload: DeviceRegisterRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeviceRegisterResult:
    now = datetime.utcnow()
    record = db.scalar(
        select(UserDevice).where(
            UserDevice.user_id == current_user.id, UserDevice.device_id == payload.device_id
        )
    )
    token_record = None
    fcm_hash = token_hash(payload.fcm_token)
    if payload.fcm_token:
        token_record = db.scalar(
            select(UserDevice).where(
                or_(UserDevice.fcm_token_hash == fcm_hash, UserDevice.fcm_token == payload.fcm_token)
            )
        )
    if token_record and token_record is not record:
        if record:
            db.delete(record)
            db.flush()
        record = token_record
        record.user_id = current_user.id
        record.device_id = payload.device_id
    if not record:
        record = UserDevice(user_id=current_user.id, device_id=payload.device_id)
        db.add(record)
    record.platform = payload.platform
    record.fcm_token = None
    record.fcm_token_ciphertext = encrypt_token(payload.fcm_token)
    record.fcm_token_hash = fcm_hash
    record.app_version = payload.app_version
    record.is_active = True
    record.last_registered_at = now
    record.last_seen_at = now
    record.updated_at = now
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Device registration conflict.") from exc
    return DeviceRegisterResult(device_id=payload.device_id)


@router.delete("/devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_call_device(
    device_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    record = db.scalar(
        select(UserDevice).where(
            UserDevice.user_id == current_user.id, UserDevice.device_id == device_id[:128]
        )
    )
    if record:
        record.is_active = False
        record.fcm_token = None
        record.fcm_token_ciphertext = None
        record.fcm_token_hash = None
        record.updated_at = datetime.utcnow()
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/ws-ticket", response_model=WebSocketTicket)
async def create_ws_ticket(current_user: User = Depends(get_current_user)) -> WebSocketTicket:
    if not settings.CALL_FEATURE_ENABLED:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Calls are disabled.")
    ticket = await presence_service.create_ticket(current_user.id)
    return WebSocketTicket(ticket=ticket, expires_in=settings.CALL_WS_TICKET_TTL_SECONDS)


@router.get("/turn-credentials", response_model=TurnCredentials)
async def turn_credentials(current_user: User = Depends(get_current_user)) -> TurnCredentials:
    try:
        return await create_turn_credentials(current_user.id)
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@router.post("", response_model=CallRead, status_code=status.HTTP_201_CREATED)
async def initiate_call(
    payload: CallCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    return await call_service.initiate(
        db, current_user, payload.callee_user_id, payload.call_type, payload.caller_device_id
    )


@router.get("/history", response_model=CallHistoryPage)
async def call_history(
    page: int = Query(default=1, ge=1, le=10000),
    limit: int = Query(default=20, ge=1, le=50),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallHistoryPage:
    calls = list(
        db.scalars(
            select(Call)
            .where(or_(Call.caller_id == current_user.id, Call.callee_id == current_user.id))
            .order_by(Call.created_at.desc())
            .offset((page - 1) * limit)
            .limit(limit + 1)
        ).all()
    )
    items = [await call_service.serialize_call(db, call, current_user.id) for call in calls[:limit]]
    return CallHistoryPage(items=items, page=page, limit=limit, has_more=len(calls) > limit)


@router.get("/blocked", response_model=list[BlockedUserRead])
def blocked_users(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
) -> list[BlockedUserRead]:
    rows = db.execute(
        select(BlockedUser, User)
        .join(User, User.id == BlockedUser.blocked_user_id)
        .where(BlockedUser.blocker_id == current_user.id)
        .order_by(BlockedUser.created_at.desc())
        .limit(200)
    ).all()
    return [
        BlockedUserRead(
            id=user.id,
            display_name=user.name,
            username=user.username or f"user_{user.id.replace('-', '')[:8]}",
            avatar_url=user.avatar or user.picture,
            blocked_at=block.created_at,
        )
        for block, user in rows
    ]


@router.post("/blocked", status_code=status.HTTP_204_NO_CONTENT)
async def block_user(
    payload: BlockRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    if payload.user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot block yourself.")
    if not db.get(User, payload.user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    existing = db.scalar(
        select(BlockedUser).where(
            BlockedUser.blocker_id == current_user.id,
            BlockedUser.blocked_user_id == payload.user_id,
        )
    )
    if not existing:
        db.add(BlockedUser(blocker_id=current_user.id, blocked_user_id=payload.user_id))
        db.commit()
    active_calls = db.scalars(
        select(Call).where(
            or_(
                and_(Call.caller_id == current_user.id, Call.callee_id == payload.user_id),
                and_(Call.caller_id == payload.user_id, Call.callee_id == current_user.id),
            ),
            ~Call.status.in_(["rejected", "cancelled", "busy", "missed", "failed", "ended"]),
        )
    ).all()
    for call in active_calls:
        await call_service.fail_call(db, call.id, current_user.id, "app_closed")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/blocked/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def unblock_user(
    user_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    record = db.scalar(
        select(BlockedUser).where(
            BlockedUser.blocker_id == current_user.id, BlockedUser.blocked_user_id == user_id[:64]
        )
    )
    if record:
        db.delete(record)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/reports", status_code=status.HTTP_204_NO_CONTENT)
def report_user(
    payload: ReportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    if payload.user_id == current_user.id or not db.get(User, payload.user_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid report target.")
    if payload.call_id:
        call = call_service.get_authorized(db, payload.call_id, current_user.id)
        if payload.user_id not in {call.caller_id, call.callee_id}:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid call report target.")
    db.add(
        CallReport(
            reporter_id=current_user.id,
            reported_user_id=payload.user_id,
            call_id=payload.call_id,
            reason=payload.reason,
            details=payload.details,
        )
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{call_id}", response_model=CallRead)
async def get_call(
    call_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    call = call_service.get_authorized(db, call_id, current_user.id)
    return await call_service.serialize_call(db, call, current_user.id)


@router.post("/{call_id}/accept", response_model=CallRead)
async def accept_call(
    call_id: str,
    payload: CallActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    call = await call_service.accept(db, call_id, current_user.id, payload.device_id)
    return await call_service.serialize_call(db, call, current_user.id)


@router.post("/{call_id}/ringing", response_model=CallRead)
async def ringing_call(
    call_id: str,
    payload: CallActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    del payload
    call = await call_service.ringing(db, call_id, current_user.id)
    return await call_service.serialize_call(db, call, current_user.id)


@router.post("/{call_id}/reject", response_model=CallRead)
async def reject_call(
    call_id: str,
    payload: CallActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    del payload
    call = await call_service.reject(db, call_id, current_user.id)
    return await call_service.serialize_call(db, call, current_user.id)


@router.post("/{call_id}/cancel", response_model=CallRead)
async def cancel_call(
    call_id: str,
    payload: CallActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    del payload
    call = await call_service.cancel(db, call_id, current_user.id)
    return await call_service.serialize_call(db, call, current_user.id)


@router.post("/{call_id}/end", response_model=CallRead)
async def end_call(
    call_id: str,
    payload: CallActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CallRead:
    call = await call_service.end(db, call_id, current_user.id, payload.end_reason)
    return await call_service.serialize_call(db, call, current_user.id)
