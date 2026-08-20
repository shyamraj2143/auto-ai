from typing import Literal

from pydantic import BaseModel, Field


class DemoChatHistoryMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1000)


class DemoChatRequest(BaseModel):
    session_id: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    message: str = Field(min_length=1, max_length=300)
    mode: Literal["chat", "research", "vision"] = "chat"
    # Accepted only for backwards-compatible clients. The server intentionally
    # ignores it so one visitor cannot supply another visitor's context.
    history: list[DemoChatHistoryMessage] = Field(default_factory=list, max_length=10)


class DemoChatResponse(BaseModel):
    content: str
    model: str
    messages_used: int
    remaining: int


class DemoChatConfig(BaseModel):
    enabled: bool
    model: str
    limit: int
