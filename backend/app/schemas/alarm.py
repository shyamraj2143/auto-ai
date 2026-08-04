from datetime import date as DateOnly, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


AlarmLanguage = Literal["hi-IN", "hinglish-IN", "en-IN"]
AlarmVoiceStyle = Literal["warm", "gentle", "energetic"]
AlarmRingtone = Literal["system", "gentle", "energetic"]
AlarmRecurrence = Literal["ONCE", "DAILY", "WEEKDAYS", "WEEKENDS", "CUSTOM", "SPECIFIC_DATE"]


class AlarmCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=1000)
    scheduled_at: datetime | None = None
    time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    date: DateOnly | None = None
    recurrence_type: AlarmRecurrence = "ONCE"
    selected_weekdays: list[int] = Field(default_factory=list, max_length=7)
    start_date: DateOnly | None = None
    end_date: DateOnly | None = None
    timezone: str = Field(default="UTC", min_length=1, max_length=80)
    language: AlarmLanguage = "hinglish-IN"
    voice_style: AlarmVoiceStyle = "warm"
    ringtone: AlarmRingtone = "system"
    repeat: list[int] = Field(default_factory=list, max_length=7)
    snooze_minutes: int = Field(default=10, ge=1, le=120)
    snooze_enabled: bool = True
    max_snooze_count: int = Field(default=3, ge=0, le=20)
    gradual_volume_enabled: bool = False
    vibration: bool = True
    client_request_id: str | None = Field(default=None, min_length=8, max_length=80)

    @field_validator("repeat")
    @classmethod
    def valid_repeat_days(cls, value: list[int]) -> list[int]:
        if any(day < 0 or day > 6 for day in value):
            raise ValueError("Repeat days must use 0 (Monday) through 6 (Sunday).")
        return sorted(set(value))

    @field_validator("selected_weekdays")
    @classmethod
    def valid_selected_weekdays(cls, value: list[int]) -> list[int]:
        return cls.valid_repeat_days(value)

    @model_validator(mode="after")
    def valid_schedule(self) -> "AlarmCreate":
        if self.scheduled_at is None and self.time is None:
            raise ValueError("Alarm time is required.")
        if self.recurrence_type == "SPECIFIC_DATE" and self.date is None:
            raise ValueError("Specific-date alarms require a date.")
        if self.recurrence_type == "CUSTOM" and not (self.selected_weekdays or self.repeat):
            raise ValueError("Custom recurrence requires at least one weekday.")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date cannot be before start date.")
        return self

    @field_validator("title", "note", "timezone", mode="before")
    @classmethod
    def normalize_text(cls, value: object) -> object:
        return " ".join(value.strip().split()) if isinstance(value, str) else value


class AlarmUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)
    scheduled_at: datetime | None = None
    time: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    date: DateOnly | None = None
    recurrence_type: AlarmRecurrence | None = None
    selected_weekdays: list[int] | None = Field(default=None, max_length=7)
    start_date: DateOnly | None = None
    end_date: DateOnly | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    language: AlarmLanguage | None = None
    voice_style: AlarmVoiceStyle | None = None
    ringtone: AlarmRingtone | None = None
    enabled: bool | None = None
    repeat: list[int] | None = Field(default=None, max_length=7)
    snooze_minutes: int | None = Field(default=None, ge=1, le=120)
    snooze_enabled: bool | None = None
    max_snooze_count: int | None = Field(default=None, ge=0, le=20)
    gradual_volume_enabled: bool | None = None
    vibration: bool | None = None

    @field_validator("title", "note", "timezone", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: object) -> object:
        return " ".join(value.strip().split()) if isinstance(value, str) else value


class AlarmAction(BaseModel):
    action: Literal["ringing", "dismiss", "snooze", "skip"]
    snooze_minutes: int = Field(default=10, ge=1, le=120)
    scheduled_at: datetime | None = None
    client_revision: int | None = Field(default=None, ge=1)


class AlarmRead(BaseModel):
    id: str
    title: str
    note: str
    scheduled_at: datetime
    time: str
    date: DateOnly | None = None
    recurrence_type: AlarmRecurrence
    selected_weekdays: list[int]
    start_date: DateOnly | None = None
    end_date: DateOnly | None = None
    timezone: str
    language: AlarmLanguage
    voice_style: AlarmVoiceStyle
    ringtone: AlarmRingtone
    repeat: list[int]
    snooze_minutes: int
    snooze_enabled: bool
    max_snooze_count: int
    gradual_volume_enabled: bool
    vibration: bool
    assistant_message: str
    ai_model: str
    ai_generated: bool
    enabled: bool
    status: str
    snooze_count: int
    revision: int
    last_triggered_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class AlarmList(BaseModel):
    items: list[AlarmRead]
    server_time: datetime


class AlarmAwakeVerification(BaseModel):
    awake: bool
    confidence: float = Field(ge=0, le=1)
    reason: str
    model: str
    photo_stored: bool = False


class AlarmAssistantCommand(BaseModel):
    transcript: str = Field(min_length=2, max_length=1000)
    timezone: str = Field(min_length=1, max_length=80)
    client_request_id: str = Field(min_length=8, max_length=80)
    language: AlarmLanguage = "hinglish-IN"


class AlarmAssistantResult(BaseModel):
    action: Literal["create", "list", "clarify", "unsupported"]
    scheduled_at: datetime | None = None
    timezone: str
    label: str = "Alarm"
    repeat: list[int] = Field(default_factory=list)
    snooze_minutes: int = 10
    needs_clarification: bool = False
    clarification_question: str | None = None
    assistant_reply: str
    confidence: float = Field(ge=0, le=1)
    intent: str = "alarm.create"
    normalized_user_text: str = ""
    emotion: dict[str, object] = Field(default_factory=dict)
    vibration: bool = True
    alarm: AlarmRead | None = None
