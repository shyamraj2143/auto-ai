from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


ScreenShareStatus = Literal["waiting", "active", "ended", "failed"]


class ScreenShareSessionCreate(BaseModel):
    viewer_user_id: str | None = Field(default=None, min_length=8, max_length=64)
    invite_link: bool = False
    expires_minutes: int = Field(default=60, ge=5, le=1440)


class ScreenShareSessionRead(BaseModel):
    session_id: str = Field(serialization_alias="sessionId")
    sharer_user_id: str = Field(serialization_alias="sharerUserId")
    viewer_user_id: str | None = Field(default=None, serialization_alias="viewerUserId")
    status: ScreenShareStatus
    created_at: datetime = Field(serialization_alias="createdAt")
    started_at: datetime | None = Field(default=None, serialization_alias="startedAt")
    ended_at: datetime | None = Field(default=None, serialization_alias="endedAt")
    expires_at: datetime | None = Field(default=None, serialization_alias="expiresAt")
    invite_link: str | None = Field(default=None, serialization_alias="inviteLink")

    model_config = {"from_attributes": True, "populate_by_name": True}


class ScreenShareTicket(BaseModel):
    ticket: str
    expires_in: int


class ScreenShareSignalEvent(BaseModel):
    schema_version: Literal[1] = 1
    event_id: str = Field(min_length=8, max_length=64)
    type: Literal[
        "join-session",
        "offer",
        "answer",
        "ice-candidate",
        "screen-share-started",
        "screen-share-ended",
        "screen-share-declined",
        "screen-share-paused",
        "screen-share-resumed",
        "ping",
    ]
    session_id: str | None = Field(default=None, max_length=64)
    sender_user_id: str | None = Field(default=None, max_length=64)
    timestamp: datetime
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def limit_payload_shape(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 32:
            raise ValueError("Signaling payload has too many fields.")
        return value
