from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.alarm import UserAlarm
from app.models.user import User
from app.schemas.alarm import AlarmAction, AlarmAwakeVerification, AlarmCreate, AlarmList, AlarmRead, AlarmUpdate
from app.services.alarm_awake_service import alarm_awake_service
from app.services.alarm_ai_service import alarm_ai_service
from app.services.alarm_notification_service import alarm_sync_data, deleted_alarm_sync_data, dispatch_alarm_sync


router = APIRouter(prefix="/alarms", tags=["alarms"])
MINIMUM_LEAD_SECONDS = 20
MAXIMUM_FUTURE_DAYS = 366 * 5
MAX_AWAKE_PHOTO_BYTES = 6 * 1024 * 1024


def utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Alarm time must include a timezone.")
    return value.astimezone(UTC).replace(tzinfo=None)


def validate_future(value: datetime) -> datetime:
    scheduled = utc_naive(value)
    now = datetime.utcnow()
    if scheduled < now + timedelta(seconds=MINIMUM_LEAD_SECONDS):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Choose an alarm time at least 20 seconds from now.")
    if scheduled > now + timedelta(days=MAXIMUM_FUTURE_DAYS):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Alarm date is too far in the future.")
    return scheduled


def alarm_read(alarm: UserAlarm) -> AlarmRead:
    def aware(value: datetime | None) -> datetime | None:
        if value is None:
            return None
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)

    return AlarmRead(
        id=alarm.id,
        title=alarm.title,
        note=alarm.note,
        scheduled_at=aware(alarm.scheduled_at),
        timezone=alarm.timezone,
        language=alarm.language,
        voice_style=alarm.voice_style,
        ringtone=alarm.ringtone,
        assistant_message=alarm.assistant_message,
        ai_model=alarm.ai_model,
        ai_generated=alarm.ai_generated,
        enabled=alarm.enabled,
        status=alarm.status,
        snooze_count=alarm.snooze_count,
        revision=alarm.revision,
        last_triggered_at=aware(alarm.last_triggered_at),
        completed_at=aware(alarm.completed_at),
        created_at=aware(alarm.created_at),
        updated_at=aware(alarm.updated_at),
    )


def owned_alarm(db: Session, user_id: str, alarm_id: str) -> UserAlarm:
    alarm = db.scalar(select(UserAlarm).where(UserAlarm.id == alarm_id[:64], UserAlarm.user_id == user_id))
    if not alarm:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Alarm not found.")
    return alarm


def queue_sync(background_tasks: BackgroundTasks, alarm: UserAlarm, action: str) -> None:
    background_tasks.add_task(dispatch_alarm_sync, alarm.user_id, alarm_sync_data(alarm, action))


@router.get("", response_model=AlarmList)
def list_alarms(
    include_completed: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmList:
    query = select(UserAlarm).where(UserAlarm.user_id == current_user.id)
    if not include_completed:
        query = query.where(UserAlarm.status.notin_(("completed", "cancelled")))
    alarms = db.scalars(query.order_by(UserAlarm.scheduled_at.asc()).limit(250)).all()
    return AlarmList(items=[alarm_read(item) for item in alarms], server_time=datetime.now(UTC))


@router.post("", response_model=AlarmRead, status_code=status.HTTP_201_CREATED)
def create_alarm(
    payload: AlarmCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmRead:
    message = alarm_ai_service.compose(
        user_name=current_user.name,
        title=payload.title,
        note=payload.note,
        language=payload.language,
        voice_style=payload.voice_style,
    )
    alarm = UserAlarm(
        user_id=current_user.id,
        title=payload.title,
        note=payload.note,
        scheduled_at=validate_future(payload.scheduled_at),
        timezone=payload.timezone,
        language=payload.language,
        voice_style=payload.voice_style,
        ringtone=payload.ringtone,
        assistant_message=message.text,
        ai_model=message.model,
        ai_generated=message.generated,
    )
    db.add(alarm)
    db.commit()
    db.refresh(alarm)
    queue_sync(background_tasks, alarm, "schedule")
    return alarm_read(alarm)


@router.patch("/{alarm_id}", response_model=AlarmRead)
def update_alarm(
    alarm_id: str,
    payload: AlarmUpdate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmRead:
    alarm = owned_alarm(db, current_user.id, alarm_id)
    changes = payload.model_dump(exclude_unset=True)
    if "scheduled_at" in changes and changes["scheduled_at"] is not None:
        changes["scheduled_at"] = validate_future(changes["scheduled_at"])
    for key in ("title", "note", "scheduled_at", "timezone", "language", "voice_style", "ringtone"):
        if key in changes and changes[key] is not None:
            setattr(alarm, key, changes[key])
    if "enabled" in changes and changes["enabled"] is not None:
        alarm.enabled = bool(changes["enabled"])
        if alarm.enabled and alarm.scheduled_at <= datetime.utcnow() + timedelta(seconds=MINIMUM_LEAD_SECONDS):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Choose a future time before enabling this alarm.")
    regenerate = any(
        key in changes and changes[key] is not None
        for key in ("title", "note", "language", "voice_style")
    )
    if regenerate:
        message = alarm_ai_service.compose(
            user_name=current_user.name,
            title=alarm.title,
            note=alarm.note,
            language=alarm.language,
            voice_style=alarm.voice_style,
        )
        alarm.assistant_message = message.text
        alarm.ai_model = message.model
        alarm.ai_generated = message.generated
    alarm.status = "scheduled" if alarm.enabled else "paused"
    alarm.completed_at = None
    alarm.revision += 1
    db.commit()
    db.refresh(alarm)
    queue_sync(background_tasks, alarm, "schedule" if alarm.enabled else "cancel")
    return alarm_read(alarm)


@router.post("/{alarm_id}/action", response_model=AlarmRead)
def alarm_action(
    alarm_id: str,
    payload: AlarmAction,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmRead:
    alarm = owned_alarm(db, current_user.id, alarm_id)
    requested_time = utc_naive(payload.scheduled_at) if payload.scheduled_at is not None else None
    if payload.client_revision is not None and payload.client_revision < alarm.revision:
        return alarm_read(alarm)
    if payload.client_revision is not None and payload.client_revision == alarm.revision:
        if payload.action == "dismiss" and alarm.status == "completed":
            return alarm_read(alarm)
        if (
            payload.action == "snooze"
            and requested_time is not None
            and alarm.status == "scheduled"
            and abs((alarm.scheduled_at - requested_time).total_seconds()) < 1
        ):
            return alarm_read(alarm)
    now = datetime.utcnow()
    sync_action: str | None = None
    if payload.action == "ringing":
        if alarm.status not in {"completed", "cancelled"}:
            alarm.status = "ringing"
            alarm.last_triggered_at = now
    elif payload.action == "dismiss":
        alarm.status = "completed"
        alarm.enabled = False
        alarm.last_triggered_at = alarm.last_triggered_at or now
        alarm.completed_at = now
        sync_action = "cancel"
    else:
        alarm.scheduled_at = (
            requested_time
            if requested_time is not None and requested_time >= now + timedelta(seconds=MINIMUM_LEAD_SECONDS)
            else now + timedelta(minutes=payload.snooze_minutes)
        )
        alarm.status = "scheduled"
        alarm.enabled = True
        alarm.snooze_count += 1
        alarm.completed_at = None
        sync_action = "schedule"
    alarm.revision = max(alarm.revision + 1, payload.client_revision or 0)
    db.commit()
    db.refresh(alarm)
    if sync_action:
        queue_sync(background_tasks, alarm, sync_action)
    return alarm_read(alarm)


@router.post("/{alarm_id}/verify-awake", response_model=AlarmAwakeVerification)
async def verify_alarm_awake(
    alarm_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmAwakeVerification:
    alarm = owned_alarm(db, current_user.id, alarm_id)
    if not alarm.enabled or alarm.status not in {"scheduled", "ringing"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This alarm is not ringing.")
    # Read into memory only. Alarm selfies are never written to disk or retained.
    image = await file.read(MAX_AWAKE_PHOTO_BYTES + 1)
    if not image:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The captured photo is empty.")
    if len(image) > MAX_AWAKE_PHOTO_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The captured photo is too large.")
    decision = await run_in_threadpool(
        alarm_awake_service.verify,
        image=image,
        filename=file.filename or "awake.jpg",
    )
    return AlarmAwakeVerification(
        awake=decision.awake,
        confidence=decision.confidence,
        reason=decision.reason,
        model=decision.model,
        photo_stored=False,
    )


@router.delete("/{alarm_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_alarm(
    alarm_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    alarm = owned_alarm(db, current_user.id, alarm_id)
    data = deleted_alarm_sync_data(alarm.id, alarm.revision + 1)
    user_id = alarm.user_id
    db.delete(alarm)
    db.commit()
    background_tasks.add_task(dispatch_alarm_sync, user_id, data)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
