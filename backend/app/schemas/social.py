from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


FollowStatus = Literal["self", "none", "pending", "following", "blocked"]


class SocialProfile(BaseModel):
    id: str
    display_name: str
    username: str
    avatar_url: str | None = None
    bio: str | None = None
    is_private: bool = False
    follow_status: FollowStatus = "none"
    can_message: bool = False
    can_audio_call: bool = False
    can_video_call: bool = False
    profile_restricted: bool = False


class SocialUserPage(BaseModel):
    items: list[SocialProfile]
    page: int
    limit: int
    has_more: bool
    unread_notifications: int = 0


class FollowRequestRead(BaseModel):
    id: str
    requested_at: datetime
    user: SocialProfile


class FollowRequestPage(BaseModel):
    items: list[FollowRequestRead]
    page: int
    limit: int
    has_more: bool


class SocialNotificationRead(BaseModel):
    id: str
    notification_type: str
    target_type: str
    target_id: str | None = None
    title: str
    body: str | None = None
    read_at: datetime | None = None
    created_at: datetime
    actor: SocialProfile | None = None


class SocialNotificationPage(BaseModel):
    items: list[SocialNotificationRead]
    page: int
    limit: int
    has_more: bool
    unread_count: int


class DirectConversationRead(BaseModel):
    thread_id: str


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    username: str | None = Field(default=None, min_length=3, max_length=48)
    bio: str | None = Field(default=None, max_length=500)
    profile_visibility: Literal["public", "private"] | None = None
    message_permission: Literal["everyone", "followers", "mutual_followers", "nobody"] | None = None
