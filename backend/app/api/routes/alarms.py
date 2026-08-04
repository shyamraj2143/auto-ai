from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.alarm import UserAlarm
from app.models.user import User
from app.schemas.alarm import AlarmAction, AlarmAssistantCommand, AlarmAssistantResult, AlarmAwakeVerification, AlarmCreate, AlarmList, AlarmRead, AlarmUpdate
from app.services.alarm_awake_service import alarm_awake_service
from app.services.alarm_ai_service import alarm_ai_service
from app.services.alarm_notification_service import alarm_sync_data, deleted_alarm_sync_data, dispatch_alarm_sync
from app.services.alarm_recurrence import next_occurrence, normalized_weekdays


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

    try:
        local = aware(alarm.scheduled_at).astimezone(ZoneInfo(alarm.timezone))
    except ZoneInfoNotFoundError:
        local = aware(alarm.scheduled_at)
    selected = [int(day) for day in alarm.repeat_rule.split(",") if day.strip().isdigit()]
    recurrence = alarm.recurrence_type or ("CUSTOM" if selected else "ONCE")
    return AlarmRead(
        id=alarm.id,
        title=alarm.title,
        note=alarm.note,
        scheduled_at=aware(alarm.scheduled_at),
        time=local.strftime("%H:%M"),
        date=alarm.alarm_date or None,
        recurrence_type=recurrence,
        selected_weekdays=selected,
        start_date=alarm.start_date or None,
        end_date=alarm.end_date or None,
        timezone=alarm.timezone,
        language=alarm.language,
        voice_style=alarm.voice_style,
        ringtone=alarm.ringtone,
        repeat=selected,
        snooze_minutes=alarm.snooze_minutes,
        snooze_enabled=alarm.snooze_enabled,
        max_snooze_count=alarm.max_snooze_count,
        gradual_volume_enabled=alarm.gradual_volume_enabled,
        vibration=alarm.vibration,
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


def next_repeat_occurrence(alarm: UserAlarm, now_utc: datetime) -> datetime | None:
    recurrence = alarm.recurrence_type or ("CUSTOM" if alarm.repeat_rule else "ONCE")
    if recurrence in {"ONCE", "SPECIFIC_DATE"}:
        return None
    result = next_occurrence(
        local_time=alarm.local_time,
        timezone=alarm.timezone,
        recurrence_type=recurrence,
        selected_weekdays=[int(day) for day in alarm.repeat_rule.split(",") if day.strip().isdigit()],
        start_date=datetime.fromisoformat(alarm.start_date).date() if alarm.start_date else None,
        end_date=datetime.fromisoformat(alarm.end_date).date() if alarm.end_date else None,
        after=now_utc.replace(tzinfo=UTC),
    )
    return result.next_trigger_at.replace(tzinfo=None) if result else None


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
    if payload.client_request_id:
        existing = db.scalar(select(UserAlarm).where(UserAlarm.user_id == current_user.id, UserAlarm.client_request_id == payload.client_request_id))
        if existing:
            return alarm_read(existing)
    recurrence = payload.recurrence_type
    selected = payload.selected_weekdays or payload.repeat
    if recurrence == "ONCE" and selected:
        recurrence = "DAILY" if selected == list(range(7)) else "CUSTOM"
    if payload.time:
        try:
            schedule = next_occurrence(
                local_time=payload.time,
                timezone=payload.timezone,
                recurrence_type=recurrence,
                alarm_date=payload.date,
                selected_weekdays=selected,
                start_date=payload.start_date,
                end_date=payload.end_date,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if schedule is None:
            raise HTTPException(status_code=422, detail="This recurrence has no future occurrence.")
        scheduled_at = validate_future(schedule.next_trigger_at)
        selected = list(schedule.weekdays)
        local_time = payload.time
    else:
        scheduled_at = validate_future(payload.scheduled_at)
        zone = ZoneInfo(payload.timezone)
        local_value = payload.scheduled_at.astimezone(zone)
        local_time = local_value.strftime("%H:%M")
        selected = list(normalized_weekdays(recurrence, selected)) if recurrence not in {"ONCE", "SPECIFIC_DATE"} else []
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
        scheduled_at=scheduled_at,
        timezone=payload.timezone,
        language=payload.language,
        voice_style=payload.voice_style,
        ringtone=payload.ringtone,
        local_time=local_time,
        alarm_date=payload.date.isoformat() if payload.date else None,
        recurrence_type=recurrence,
        start_date=payload.start_date.isoformat() if payload.start_date else None,
        end_date=payload.end_date.isoformat() if payload.end_date else None,
        repeat_rule=",".join(str(day) for day in selected),
        snooze_minutes=payload.snooze_minutes,
        snooze_enabled=payload.snooze_enabled,
        max_snooze_count=payload.max_snooze_count,
        gradual_volume_enabled=payload.gradual_volume_enabled,
        vibration=payload.vibration,
        client_request_id=payload.client_request_id,
        assistant_message=message.text,
        ai_model=message.model,
        ai_generated=message.generated,
    )
    db.add(alarm)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if payload.client_request_id:
            existing = db.scalar(select(UserAlarm).where(UserAlarm.user_id == current_user.id, UserAlarm.client_request_id == payload.client_request_id))
            if existing:
                return alarm_read(existing)
        raise
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
    selected_change = changes.pop("selected_weekdays", changes.pop("repeat", None))
    if selected_change is not None:
        alarm.repeat_rule = ",".join(str(day) for day in sorted(set(selected_change)))
    for key in ("title", "note", "scheduled_at", "timezone", "language", "voice_style", "ringtone", "snooze_minutes", "snooze_enabled", "max_snooze_count", "gradual_volume_enabled", "vibration"):
        if key in changes and changes[key] is not None:
            setattr(alarm, key, changes[key])
    if "time" in changes and changes["time"] is not None:
        alarm.local_time = changes["time"]
    if "recurrence_type" in changes and changes["recurrence_type"] is not None:
        alarm.recurrence_type = changes["recurrence_type"]
    for payload_key, model_key in (("date", "alarm_date"), ("start_date", "start_date"), ("end_date", "end_date")):
        if payload_key in changes:
            value = changes[payload_key]
            setattr(alarm, model_key, value.isoformat() if value else None)
    normalized_schedule_changed = any(key in changes for key in ("time", "date", "recurrence_type", "start_date", "end_date")) or selected_change is not None
    if normalized_schedule_changed:
        try:
            schedule = next_occurrence(
                local_time=alarm.local_time,
                timezone=alarm.timezone,
                recurrence_type=alarm.recurrence_type,
                alarm_date=datetime.fromisoformat(alarm.alarm_date).date() if alarm.alarm_date else None,
                selected_weekdays=[int(day) for day in alarm.repeat_rule.split(",") if day],
                start_date=datetime.fromisoformat(alarm.start_date).date() if alarm.start_date else None,
                end_date=datetime.fromisoformat(alarm.end_date).date() if alarm.end_date else None,
                enabled=changes.get("enabled", alarm.enabled),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if changes.get("enabled", alarm.enabled) and schedule is None:
            raise HTTPException(status_code=422, detail="This recurrence has no future occurrence.")
        if schedule:
            alarm.scheduled_at = validate_future(schedule.next_trigger_at)
            alarm.repeat_rule = ",".join(str(day) for day in schedule.weekdays)
    if "enabled" in changes and changes["enabled"] is not None:
        alarm.enabled = bool(changes["enabled"])
        if alarm.enabled and alarm.scheduled_at <= datetime.utcnow() + timedelta(seconds=MINIMUM_LEAD_SECONDS):
            next_trigger = next_repeat_occurrence(alarm, datetime.utcnow())
            if next_trigger is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Choose a future time before enabling this alarm.")
            alarm.scheduled_at = next_trigger
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


@router.post("/assistant/command", response_model=AlarmAssistantResult)
def assistant_command(
    payload: AlarmAssistantCommand,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> AlarmAssistantResult:
    existing = db.scalar(select(UserAlarm).where(UserAlarm.user_id == current_user.id, UserAlarm.client_request_id == payload.client_request_id))
    if existing:
        return AlarmAssistantResult(action="create", scheduled_at=alarm_read(existing).scheduled_at, timezone=existing.timezone, label=existing.title, repeat=[int(x) for x in existing.repeat_rule.split(",") if x], snooze_minutes=existing.snooze_minutes, assistant_reply=f"{existing.title} alarm is already set.", confidence=1, alarm=alarm_read(existing))
    try:
        alarm_summary = [{"id": item.id, "title": item.title, "scheduled_at": item.scheduled_at.replace(tzinfo=UTC).isoformat(), "enabled": item.enabled} for item in db.scalars(select(UserAlarm).where(UserAlarm.user_id == current_user.id).order_by(UserAlarm.scheduled_at).limit(50))]
        result = alarm_ai_service.interpret(transcript=payload.transcript, timezone=payload.timezone, language=payload.language, alarms=alarm_summary, platform="android")
    except Exception:
        return AlarmAssistantResult(
            action="clarify",
            timezone=payload.timezone,
            needs_clarification=True,
            clarification_question="Command साफ नहीं समझ आया। कृपया transcript ठीक करें या दोबारा धीरे बोलें।",
            assistant_reply="Command साफ नहीं समझ आया। नीचे text ठीक करके Retry करें, या mic से दोबारा धीरे बोलें।",
            confidence=0,
        )
    parsed = AlarmAssistantResult.model_validate(result)
    if parsed.action == "list":
        zone = ZoneInfo(payload.timezone)
        today = datetime.now(zone).date()
        todays = [item for item in db.scalars(select(UserAlarm).where(UserAlarm.user_id == current_user.id).order_by(UserAlarm.scheduled_at)) if item.scheduled_at.replace(tzinfo=UTC).astimezone(zone).date() == today]
        parsed.assistant_reply = "आज कोई alarm नहीं है।" if not todays else "आज के alarms: " + ", ".join(f"{item.title} {item.scheduled_at.replace(tzinfo=UTC).astimezone(zone).strftime('%H:%M')}" for item in todays)
        return parsed
    if parsed.action != "create" or parsed.needs_clarification or parsed.scheduled_at is None:
        return parsed
    create = AlarmCreate(title=parsed.label, note=parsed.normalized_user_text or payload.transcript, scheduled_at=parsed.scheduled_at, timezone=payload.timezone, language=payload.language, repeat=parsed.repeat, snooze_minutes=parsed.snooze_minutes, vibration=parsed.vibration, client_request_id=payload.client_request_id)
    saved = create_alarm(create, background_tasks, db, current_user)
    parsed.alarm = saved
    local = saved.scheduled_at.astimezone(ZoneInfo(saved.timezone))
    parsed.assistant_reply = f"{local.strftime('%d %B %Y को %H:%M')} बजे ‘{saved.title}’ का alarm set हो गया है।"
    return parsed


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
        same_occurrence_dismiss = (
            payload.action == "dismiss"
            and alarm.status in {"scheduled", "ringing"}
            and requested_time is not None
            and abs((alarm.scheduled_at - requested_time).total_seconds()) < 1
        )
        if not same_occurrence_dismiss:
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
        next_occurrence = next_repeat_occurrence(alarm, now)
        alarm.status = "scheduled" if next_occurrence else "completed"
        alarm.enabled = bool(next_occurrence)
        if next_occurrence:
            alarm.scheduled_at = next_occurrence
        alarm.last_triggered_at = alarm.last_triggered_at or now
        alarm.completed_at = None if next_occurrence else now
        sync_action = "schedule" if next_occurrence else "cancel"
    elif payload.action == "skip":
        next_trigger = next_repeat_occurrence(alarm, alarm.scheduled_at)
        if next_trigger is None:
            raise HTTPException(status_code=409, detail="Only repeating alarms can skip an occurrence.")
        alarm.scheduled_at = next_trigger
        alarm.status = "scheduled"
        alarm.completed_at = None
        sync_action = "schedule"
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
