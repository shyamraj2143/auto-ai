from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


AlarmLanguage = Literal["hi-IN", "hinglish-IN", "en-IN"]
AlarmVoiceStyle = Literal["warm", "gentle", "energetic"]
AlarmRingtone = Literal["system", "gentle", "energetic"]


class AlarmCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=1000)
    scheduled_at: datetime
    timezone: str = Field(default="UTC", min_length=1, max_length=80)
    language: AlarmLanguage = "hinglish-IN"
    voice_style: AlarmVoiceStyle = "warm"
    ringtone: AlarmRingtone = "system"

    @field_validator("title", "note", "timezone", mode="before")
    @classmethod
    def normalize_text(cls, value: object) -> object:
        return " ".join(value.strip().split()) if isinstance(value, str) else value


class AlarmUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    note: str | None = Field(default=None, max_length=1000)
    scheduled_at: datetime | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    language: AlarmLanguage | None = None
    voice_style: AlarmVoiceStyle | None = None
    ringtone: AlarmRingtone | None = None
    enabled: bool | None = None

    @field_validator("title", "note", "timezone", mode="before")
    @classmethod
    def normalize_optional_text(cls, value: object) -> object:
        return " ".join(value.strip().split()) if isinstance(value, str) else value


class AlarmAction(BaseModel):
    action: Literal["ringing", "dismiss", "snooze"]
    snooze_minutes: int = Field(default=10, ge=1, le=120)
    scheduled_at: datetime | None = None
    client_revision: int | None = Field(default=None, ge=1)


class AlarmRead(BaseModel):
    id: str
    title: str
    note: str
    scheduled_at: datetime
    timezone: str
    language: AlarmLanguage
    voice_style: AlarmVoiceStyle
    ringtone: AlarmRingtone
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
