from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


CallType = Literal["audio", "video"]
CallPermission = Literal["everyone", "previous_contacts", "nobody"]
PresenceState = Literal["online", "away", "background", "busy", "offline", "hidden"]


class PublicCallUser(BaseModel):
    id: str
    display_name: str
    username: str
    avatar_url: str | None = None
    presence: PresenceState = "offline"
    availability: str = "Offline"
    can_audio_call: bool = False
    can_video_call: bool = False
    last_seen_at: datetime | None = None


class CallUserPage(BaseModel):
    items: list[PublicCallUser]
    page: int
    limit: int
    has_more: bool


class CallSettingsRead(BaseModel):
    is_discoverable: bool
    show_online_status: bool
    show_last_seen: bool
    allow_audio_calls: bool
    allow_video_calls: bool
    call_permission: CallPermission
    silence_unknown_callers: bool
    call_notification_sound: bool
    vibration: bool
    data_saving_mode: bool

    model_config = {"from_attributes": True}


class CallSettingsUpdate(BaseModel):
    is_discoverable: bool | None = None
    show_online_status: bool | None = None
    show_last_seen: bool | None = None
    allow_audio_calls: bool | None = None
    allow_video_calls: bool | None = None
    call_permission: CallPermission | None = None
    silence_unknown_callers: bool | None = None
    call_notification_sound: bool | None = None
    vibration: bool | None = None
    data_saving_mode: bool | None = None


class DeviceRegisterRequest(BaseModel):
    device_id: str = Field(min_length=4, max_length=128)
    platform: Literal["android", "web"] = "web"
    fcm_token: str | None = Field(default=None, min_length=16, max_length=512)
    app_version: str | None = Field(default=None, max_length=64)
    app_version_code: int = Field(default=0, ge=0)
    device_name: str | None = Field(default=None, max_length=120)

    @field_validator("device_id", "fcm_token", "app_version", "device_name")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class DeviceRegisterResult(BaseModel):
    device_id: str
    registered: bool = True


class CallCreateRequest(BaseModel):
    callee_user_id: str = Field(min_length=8, max_length=64)
    call_type: CallType = "video"
    caller_device_id: str | None = Field(default=None, max_length=128)


class CallActionRequest(BaseModel):
    device_id: str | None = Field(default=None, max_length=128)
    end_reason: str | None = Field(default=None, max_length=32)


class CallRead(BaseModel):
    id: str
    caller_id: str
    callee_id: str
    call_type: CallType
    status: str
    created_at: datetime
    ringing_at: datetime | None = None
    accepted_at: datetime | None = None
    connected_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int = 0
    ended_by: str | None = None
    end_reason: str | None = None
    direction: Literal["incoming", "outgoing"]
    peer: PublicCallUser
    delivery: str | None = None
    silent: bool = False


class CallHistoryPage(BaseModel):
    items: list[CallRead]
    page: int
    limit: int
    has_more: bool


class WebSocketTicket(BaseModel):
    ticket: str
    expires_in: int


class TurnCredentials(BaseModel):
    configured: bool
    provider: str
    ice_servers: list[dict[str, Any]] = Field(serialization_alias="iceServers")
    expires_at: datetime | None = Field(default=None, serialization_alias="expiresAt")
    relay_configured: bool = Field(default=False, serialization_alias="relayConfigured")
    warning: str | None = None

    model_config = {"populate_by_name": True}


class CallFeatureConfig(BaseModel):
    enabled: bool
    realtime_configured: bool
    turn_configured: bool
    firebase_configured: bool
    ring_timeout_seconds: int
    reconnect_grace_seconds: int
    diagnostic: str | None = None


class CallHealth(BaseModel):
    calling_enabled: bool
    redis_configured: bool
    redis_reachable: bool
    websocket_ready: bool


class BlockRequest(BaseModel):
    user_id: str = Field(min_length=8, max_length=64)


class BlockedUserRead(BaseModel):
    id: str
    display_name: str
    username: str
    avatar_url: str | None = None
    blocked_at: datetime


class ReportRequest(BaseModel):
    user_id: str = Field(min_length=8, max_length=64)
    reason: Literal["spam", "harassment", "inappropriate", "impersonation", "other"]
    call_id: str | None = Field(default=None, max_length=64)
    details: str | None = Field(default=None, max_length=1000)


class SignalEvent(BaseModel):
    schema_version: Literal[1] = 1
    event_id: str = Field(min_length=8, max_length=64)
    type: Literal[
        "presence.ready",
        "presence.heartbeat",
        "presence.status",
        "call.ringing",
        "call.accept",
        "call.reject",
        "call.cancel",
        "call.end",
        "call.busy",
        "call.connected",
        "call.media_state",
        "webrtc.offer",
        "webrtc.answer",
        "webrtc.ice_candidate",
        "webrtc.renegotiate",
        "webrtc.ice_restart",
        "ping",
    ]
    call_id: str | None = Field(default=None, max_length=64)
    sender_user_id: str | None = Field(default=None, max_length=64)
    timestamp: datetime
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def limit_payload_shape(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 32:
            raise ValueError("Signaling payload has too many fields.")
        return value
