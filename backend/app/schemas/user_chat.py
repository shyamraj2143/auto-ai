from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


MessageType = Literal["text", "image", "file", "audio", "system"]
MessagePermission = Literal["everyone", "followers", "mutual_followers", "known_users", "nobody"]


class ChatPublicUser(BaseModel):
    id: str
    display_name: str
    username: str
    avatar_url: str | None = None
    presence: str = "offline"
    availability: str = "Offline"
    can_audio_call: bool = False
    can_video_call: bool = False
    last_seen_at: datetime | None = None


class ChatUserPage(BaseModel):
    items: list[ChatPublicUser]
    page: int
    limit: int
    has_more: bool


class ChatMessageRead(BaseModel):
    id: str
    thread_id: str
    sender_id: str
    client_message_id: str | None = None
    message_type: str
    text_content: str | None = None
    attachment_url: str | None = None
    attachment_name: str | None = None
    attachment_size: int | None = None
    mime_type: str | None = None
    created_at: datetime
    edited_at: datetime | None = None
    deleted_at: datetime | None = None
    reply_to_message_id: str | None = None
    status: Literal["sent", "delivered", "read"] = "sent"


class ChatThreadRead(BaseModel):
    id: str
    is_group: bool = False
    created_at: datetime
    updated_at: datetime
    peer: ChatPublicUser
    last_message: ChatMessageRead | None = None
    unread_count: int = 0
    archived: bool = False
    pinned: bool = False
    muted: bool = False


class ChatThreadPage(BaseModel):
    items: list[ChatThreadRead]
    page: int
    limit: int
    has_more: bool


class ThreadCreateRequest(BaseModel):
    peer_user_id: str = Field(min_length=8, max_length=64)


class MessageCreateRequest(BaseModel):
    client_message_id: str | None = Field(default=None, max_length=80)
    message_type: MessageType = "text"
    text_content: str | None = Field(default=None, max_length=8000)
    attachment_url: str | None = Field(default=None, max_length=700)
    attachment_name: str | None = Field(default=None, max_length=255)
    attachment_size: int | None = Field(default=None, ge=0)
    mime_type: str | None = Field(default=None, max_length=120)
    reply_to_message_id: str | None = Field(default=None, max_length=64)

    @field_validator("text_content")
    @classmethod
    def trim_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ThreadFlagRequest(BaseModel):
    enabled: bool = True


class ChatSettingsRead(BaseModel):
    read_receipts_enabled: bool
    last_seen_enabled: bool
    typing_indicator_enabled: bool
    allow_messages_from: MessagePermission

    model_config = {"from_attributes": True}


class ChatSettingsUpdate(BaseModel):
    read_receipts_enabled: bool | None = None
    last_seen_enabled: bool | None = None
    typing_indicator_enabled: bool | None = None
    allow_messages_from: MessagePermission | None = None


class ChatWebSocketEvent(BaseModel):
    type: str = Field(max_length=40)
    event_id: str = Field(min_length=8, max_length=80)
    thread_id: str | None = Field(default=None, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def limit_payload(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 32:
            raise ValueError("Payload has too many fields.")
        return value
