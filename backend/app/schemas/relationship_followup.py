from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator


RelationshipType = Literal["family", "friend", "relative", "mentor", "colleague", "professional", "other"]
ContactChannel = Literal["phone", "email", "whatsapp", "other"]
Cadence = Literal["weekly", "fortnightly", "monthly", "quarterly", "custom"]
Priority = Literal["normal", "important", "high"]
ContactStatus = Literal["active", "paused", "archived"]
Language = Literal["hi", "en"]


def normalize_text(value: object) -> object:
    if not isinstance(value, str):
        return value
    return " ".join(value.strip().split())


def validate_timezone(value: str) -> str:
    cleaned = value.strip()
    try:
        ZoneInfo(cleaned)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Use a valid IANA timezone, for example Asia/Kolkata.") from exc
    return cleaned


class ContactCreate(BaseModel):
    display_name: str = Field(min_length=2, max_length=120)
    relationship_type: RelationshipType
    preferred_channel: ContactChannel | None = None
    contact_value: str = Field(default="", max_length=320)
    last_contacted_at: datetime | None = None
    cadence: Cadence
    followup_interval_days: int | None = Field(default=None, ge=1, le=730)
    next_followup_at: datetime
    preferred_reminder_time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str = Field(min_length=1, max_length=80)
    priority: Priority = "normal"
    notes: str = Field(default="", max_length=4000)
    preferred_language: Language = "hi"
    client_request_id: str = Field(min_length=8, max_length=80)

    _normalize = field_validator("display_name", "contact_value", "notes", mode="before")(normalize_text)
    _timezone = field_validator("timezone")(validate_timezone)

    @model_validator(mode="after")
    def validate_cadence(self) -> "ContactCreate":
        if self.cadence == "custom" and self.followup_interval_days is None:
            raise ValueError("Custom cadence requires followup_interval_days.")
        return self


class ContactUpdate(BaseModel):
    revision: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=80)
    display_name: str | None = Field(default=None, min_length=2, max_length=120)
    relationship_type: RelationshipType | None = None
    preferred_channel: ContactChannel | None = None
    contact_value: str | None = Field(default=None, max_length=320)
    last_contacted_at: datetime | None = None
    cadence: Cadence | None = None
    followup_interval_days: int | None = Field(default=None, ge=1, le=730)
    next_followup_at: datetime | None = None
    preferred_reminder_time: str | None = Field(default=None, pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    timezone: str | None = Field(default=None, min_length=1, max_length=80)
    priority: Priority | None = None
    notes: str | None = Field(default=None, max_length=4000)
    preferred_language: Language | None = None

    _normalize = field_validator("display_name", "contact_value", "notes", mode="before")(normalize_text)

    @field_validator("timezone")
    @classmethod
    def valid_optional_timezone(cls, value: str | None) -> str | None:
        return validate_timezone(value) if value is not None else None


class ContactAction(BaseModel):
    revision: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=80)


class MarkContacted(ContactAction):
    contacted_at: datetime
    channel: ContactChannel | None = None
    note: str = Field(default="", max_length=2000)

    _normalize = field_validator("note", mode="before")(normalize_text)


class SnoozeRequest(ContactAction):
    minutes: int = Field(ge=5, le=10080)


class RescheduleRequest(ContactAction):
    scheduled_at: datetime


class NotificationPreferenceUpdate(BaseModel):
    enabled: bool
    detailed_preview: bool
    permission_state: Literal["unknown", "granted", "denied", "permanent_denial", "unsupported"]


class AiSuggestionRequest(BaseModel):
    language: Language = "hi"
    tone: Literal["friendly", "formal", "caring"] = "friendly"
    context: str = Field(default="", max_length=500)

    _normalize = field_validator("context", mode="before")(normalize_text)


class InteractionRead(BaseModel):
    id: str
    contacted_at: datetime
    channel: str | None
    note: str
    created_at: datetime


class EventRead(BaseModel):
    id: str
    scheduled_at: datetime
    status: str
    completed_at: datetime | None
    snoozed_until: datetime | None
    sent_at: datetime | None
    attempt_count: int
    failure_code: str | None


class ContactRead(BaseModel):
    id: str
    display_name: str
    relationship_type: RelationshipType
    preferred_channel: ContactChannel | None
    contact_value: str
    last_contacted_at: datetime | None
    cadence: Cadence
    followup_interval_days: int
    next_followup_at: datetime
    preferred_reminder_time: str
    timezone: str
    priority: Priority
    notes: str
    preferred_language: Language
    status: ContactStatus
    revision: int
    created_at: datetime
    updated_at: datetime


class ContactDetail(ContactRead):
    interactions: list[InteractionRead]
    events: list[EventRead]


class ContactPage(BaseModel):
    items: list[ContactRead]
    page: int
    limit: int
    total: int
    has_more: bool


class FollowupSummary(BaseModel):
    overdue: int
    today: int
    upcoming: int
    recently_contacted: int
    paused: int
    archived: int
    unread_due: int
    next_due_at: datetime | None


class NotificationPreferenceRead(BaseModel):
    enabled: bool
    detailed_preview: bool
    permission_state: str
    updated_at: datetime


class AiSuggestionRead(BaseModel):
    suggestion: str
    model: str
