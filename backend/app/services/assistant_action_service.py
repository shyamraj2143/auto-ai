import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import AliasChoices, BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.alarm import UserAlarm
from app.models.assistant_action import AssistantActionLog
from app.models.user import User
from app.schemas.alarm import AlarmCreate, AlarmUpdate
from app.services.groq_service import groq_service


class AlarmCreateArgs(AlarmCreate):
    title: str = Field(default="Alarm", min_length=1, max_length=120)
    label: str | None = Field(default=None, max_length=120)
    repeat: list[int] = Field(default_factory=list, validation_alias=AliasChoices("repeat", "repeat_days"))

class AlarmTargetArgs(BaseModel):
    alarm_id: str | None = Field(default=None, max_length=64)
    target: str | None = Field(default=None, max_length=120)

class AlarmUpdateArgs(AlarmTargetArgs):
    scheduled_at: datetime | None = None
    title: str | None = Field(default=None, max_length=120)
    enabled: bool | None = None
    repeat: list[int] | None = None
    snooze_minutes: int | None = Field(default=None, ge=1, le=120)
    vibration: bool | None = None

class AlarmSnoozeArgs(AlarmTargetArgs):
    minutes: int = Field(default=10, ge=1, le=120)

class AlarmListArgs(BaseModel):
    date: str | None = None
    include_completed: bool = False

class NavigationArgs(BaseModel):
    screen: Literal["alarms", "settings", "chat", "calls", "messages", "library"]

class SettingsArgs(BaseModel):
    key: Literal["vibration", "voice_input", "spoken_responses", "personalization", "conversation_memory", "action_confirmations"] | None = None
    value: bool | None = None

@dataclass(frozen=True)
class ActionManifest:
    name: str
    description: str
    schema: type[BaseModel]
    risk: Literal["low", "medium", "high"]
    confirmation: bool
    platforms: tuple[str, ...]
    permissions: tuple[str, ...] = ()
    undo: bool = False

class ToolRegistry:
    def __init__(self) -> None: self._tools: dict[str, ActionManifest] = {}
    def register(self, manifest: ActionManifest) -> None:
        if manifest.name in self._tools: raise RuntimeError(f"Duplicate action: {manifest.name}")
        self._tools[manifest.name] = manifest
    def prompt_catalog(self, platform: str) -> list[dict[str, Any]]:
        return [{"name": x.name, "description": x.description, "input_schema": x.schema.model_json_schema(), "risk_level": x.risk, "requires_confirmation": x.confirmation} for x in self._tools.values() if platform in x.platforms]

registry = ToolRegistry()
for manifest in (
    ActionManifest("alarm.create", "Create a one-time or recurring alarm", AlarmCreateArgs, "low", False, ("web", "android", "ios"), ("alarms",)),
    ActionManifest("alarm.update", "Edit an existing alarm", AlarmUpdateArgs, "medium", True, ("web", "android", "ios"), ("alarms",), True),
    ActionManifest("alarm.delete", "Delete an existing alarm", AlarmTargetArgs, "high", True, ("web", "android", "ios"), ("alarms",), True),
    ActionManifest("alarm.enable", "Enable an alarm", AlarmTargetArgs, "medium", True, ("web", "android", "ios"), ("alarms",)),
    ActionManifest("alarm.disable", "Disable an alarm", AlarmTargetArgs, "medium", True, ("web", "android", "ios"), ("alarms",), True),
    ActionManifest("alarm.snooze", "Snooze an alarm", AlarmSnoozeArgs, "low", False, ("web", "android", "ios"), ("alarms",)),
    ActionManifest("alarm.list", "List the user's alarms", AlarmListArgs, "low", False, ("web", "android", "ios"), ("alarms",)),
    ActionManifest("navigation.open_screen", "Open an allowlisted app screen", NavigationArgs, "low", False, ("web", "android", "ios")),
    ActionManifest("settings.get", "Read assistant-controlled settings", SettingsArgs, "low", False, ("web", "android", "ios")),
    ActionManifest("settings.update", "Update one assistant setting", SettingsArgs, "medium", True, ("web", "android", "ios"), (), True),
): registry.register(manifest)

class PlannedAction(BaseModel):
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)

class Plan(BaseModel):
    mode: Literal["answer_only", "action_only", "answer_and_action", "clarification_required", "confirmation_required", "unsupported_action", "error"]
    intent: str = "conversation"
    emotion: dict[str, Any] = Field(default_factory=lambda: {"label": "neutral", "confidence": 0})
    assistant_reply: str
    normalized_user_text: str = ""
    needs_clarification: bool = False
    clarification_question: str | None = None
    actions: list[PlannedAction] = Field(default_factory=list, max_length=3)

def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)

def serialize_alarm(item: UserAlarm) -> dict[str, Any]:
    return {"id": item.id, "title": item.title, "scheduled_at": _aware(item.scheduled_at).isoformat(), "timezone": item.timezone, "repeat": [int(x) for x in item.repeat_rule.split(",") if x], "snooze_minutes": item.snooze_minutes, "vibration": item.vibration, "ringtone": item.ringtone, "enabled": item.enabled, "status": item.status, "revision": item.revision}

class ActionAssistantService:
    def plan(self, message: str, timezone: str, context: list[dict[str, str]], platform: str) -> tuple[Plan, str]:
        try: now = datetime.now(ZoneInfo(timezone))
        except ZoneInfoNotFoundError as exc: raise HTTPException(status_code=422, detail="Device timezone is invalid.") from exc
        system = "You are AutoAI's Groq-only Action Assistant. Understand Hindi, Hinglish, English, typos and conversational references. Return one JSON object only matching the supplied contract. Never invent a tool. Ask one short clarification if a date, time, target, or destructive intent is ambiguous. Resolve missing year to the next future occurrence in the device timezone. Never schedule a past time. Keep replies concise and empathetic. Do not claim success; execution happens after planning."
        prompt = {"current_device_time": now.isoformat(), "timezone": timezone, "tools": registry.prompt_catalog(platform), "response_contract": Plan.model_json_schema(), "conversation_context": context[-12:], "user_message": message}
        try:
            raw, _, model = groq_service.complete([{"role":"system","content":system},{"role":"user","content":json.dumps(prompt, ensure_ascii=False)}], provider="groq", model=settings.GROQ_ASSISTANT_MODEL or settings.GROQ_MODEL, temperature=0, max_tokens=1600, request_timeout=settings.GROQ_REQUEST_TIMEOUT_SECONDS)
            payload = json.loads(raw[raw.find("{"):raw.rfind("}") + 1])
            return Plan.model_validate(payload), model
        except (ValueError, json.JSONDecodeError, ValidationError) as exc:
            raise HTTPException(status_code=502, detail="Groq returned an invalid action response. Please retry.") from exc

    @staticmethod
    def _target(db: Session, user_id: str, args: AlarmTargetArgs) -> UserAlarm:
        query = select(UserAlarm).where(UserAlarm.user_id == user_id)
        if args.alarm_id:
            alarm = db.scalar(query.where(UserAlarm.id == args.alarm_id))
            if not alarm: raise HTTPException(status_code=404, detail="Alarm not found.")
            return alarm
        target = (args.target or "").strip().lower()
        if not target: raise HTTPException(status_code=409, detail="Which alarm should I use?")
        matches = list(db.scalars(query.where(UserAlarm.title.ilike(f"%{target}%")).order_by(UserAlarm.scheduled_at).limit(5)))
        if len(matches) != 1: raise HTTPException(status_code=409, detail="Multiple alarms match. Please specify the alarm name or time." if matches else "No matching alarm was found.")
        return matches[0]

    def execute(self, db: Session, user: User, tool: str, validated: BaseModel, request_id: str) -> dict[str, Any]:
        now = datetime.now(UTC).replace(tzinfo=None)
        if tool == "alarm.create":
            args = validated
            scheduled = args.scheduled_at.astimezone(UTC).replace(tzinfo=None)
            if scheduled < now + timedelta(seconds=20): raise HTTPException(status_code=422, detail="Alarm time must be in the future.")
            existing = db.scalar(select(UserAlarm).where(UserAlarm.user_id == user.id, UserAlarm.client_request_id == (args.client_request_id or request_id)))
            if existing: return {"alarm": serialize_alarm(existing), "duplicate": True}
            alarm = UserAlarm(user_id=user.id, title=args.label or args.title, note=args.note, scheduled_at=scheduled, timezone=args.timezone, language=args.language, voice_style=args.voice_style, ringtone=args.ringtone, repeat_rule=",".join(map(str,args.repeat)), snooze_minutes=args.snooze_minutes, vibration=args.vibration, client_request_id=args.client_request_id or request_id, assistant_message=f"{args.label or args.title} alarm", ai_model=settings.GROQ_ASSISTANT_MODEL or settings.GROQ_MODEL, ai_generated=True)
            db.add(alarm); db.commit(); db.refresh(alarm); return {"alarm": serialize_alarm(alarm)}
        if tool == "alarm.list":
            query = select(UserAlarm).where(UserAlarm.user_id == user.id)
            if not validated.include_completed: query = query.where(UserAlarm.status.notin_(("completed","cancelled")))
            return {"alarms":[serialize_alarm(x) for x in db.scalars(query.order_by(UserAlarm.scheduled_at).limit(100))]}
        if tool == "navigation.open_screen": return {"client_action":{"type":"navigate","screen":validated.screen}}
        if tool.startswith("settings."): return {"client_action":{"type":tool,**validated.model_dump()}}
        alarm = self._target(db,user.id,validated)
        if tool == "alarm.delete": db.delete(alarm); db.commit(); return {"deleted_alarm_id":alarm.id}
        if tool == "alarm.snooze": alarm.scheduled_at = now + timedelta(minutes=validated.minutes); alarm.enabled=True; alarm.status="scheduled"; alarm.snooze_count += 1
        elif tool == "alarm.update":
            for key,value in validated.model_dump(exclude_none=True,exclude={"alarm_id","target"}).items():
                if key == "scheduled_at":
                    value=value.astimezone(UTC).replace(tzinfo=None)
                    if value < now + timedelta(seconds=20): raise HTTPException(status_code=422, detail="Alarm time must be in the future.")
                elif key == "repeat": alarm.repeat_rule=",".join(map(str,value)); continue
                setattr(alarm,key,value)
        elif tool in {"alarm.enable","alarm.disable"}:
            enabling=tool.endswith("enable")
            if enabling and alarm.scheduled_at < now + timedelta(seconds=20): raise HTTPException(status_code=409, detail="Set a future time before enabling this alarm.")
            alarm.enabled=enabling; alarm.status="scheduled" if enabling else "paused"
        alarm.revision += 1; db.commit(); db.refresh(alarm); return {"alarm":serialize_alarm(alarm)}

assistant_action_service = ActionAssistantService()
