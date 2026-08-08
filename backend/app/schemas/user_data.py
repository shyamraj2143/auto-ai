from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class BackupMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    role: Literal["user", "assistant", "system"]
    content: str = Field(max_length=1_000_000)
    model: str | None = Field(default=None, max_length=160)
    token_count: int = Field(default=0, ge=0)
    created_at: datetime


class BackupChat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=160)
    model: str = Field(min_length=1, max_length=160)
    mode: str = Field(default="normal", max_length=32)
    created_at: datetime
    updated_at: datetime
    messages: list[BackupMessage] = Field(default_factory=list, max_length=20_000)


class ChatBackup(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_name: Literal["autoai.chat-backup"] = Field(alias="schema", serialization_alias="schema")
    schema_version: Literal[1]
    exported_at: datetime
    chats: list[BackupChat] = Field(default_factory=list, max_length=5_000)


class BackupPreview(BaseModel):
    valid: bool
    schema_version: int
    backup_date: datetime
    chat_count: int
    message_count: int


class RestoreRequest(BaseModel):
    backup: ChatBackup
    mode: Literal["merge", "replace"] = "merge"
    confirm_replace: bool = False

    @field_validator("confirm_replace")
    @classmethod
    def require_boolean(cls, value: bool) -> bool:
        return bool(value)


class RestoreResult(BaseModel):
    mode: Literal["merge", "replace"]
    chats_imported: int
    chats_skipped: int
    messages_imported: int


class UsageBucket(BaseModel):
    period: str
    requests: int
    input_tokens: int
    output_tokens: int
    total_tokens: int


class UsageDimension(BaseModel):
    provider: str
    model: str
    requests: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    average_latency_ms: int
    cache_hits: int
    cache_misses: int
    errors: int


class UserUsageResponse(BaseModel):
    start_at: datetime
    end_at: datetime
    requests: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    average_latency_ms: int
    cache_hits: int
    cache_misses: int
    errors: int
    buckets: list[UsageBucket]
    dimensions: list[UsageDimension]
