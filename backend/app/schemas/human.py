from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class InteractionProfileRead(BaseModel):
    id: str
    user_id: str
    trust_score: int
    rapport_score: int
    respect_score: int
    curiosity_score: int
    confidence_score: int
    frustration_score: int
    humor_score: int
    communication_style: dict[str, Any] = Field(default_factory=dict)
    personality_blend: dict[str, Any] = Field(default_factory=dict)
    favorite_topics: list[str] = Field(default_factory=list)
    current_projects: list[str] = Field(default_factory=list)
    long_term_objectives: list[str] = Field(default_factory=list)
    learning_style: str | None = None
    first_interaction_at: datetime
    last_interaction_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MemoryCreate(BaseModel):
    category: str = Field(min_length=1, max_length=80)
    key: str = Field(min_length=1, max_length=160)
    value: str = Field(min_length=1, max_length=2000)
    confidence: float = Field(default=0.9, ge=0, le=1)
    source: str = Field(default="user", max_length=80)


class MemoryUpdate(BaseModel):
    category: str | None = Field(default=None, min_length=1, max_length=80)
    key: str | None = Field(default=None, min_length=1, max_length=160)
    value: str | None = Field(default=None, min_length=1, max_length=2000)
    confidence: float | None = Field(default=None, ge=0, le=1)
    source: str | None = Field(default=None, max_length=80)


class MemoryRead(BaseModel):
    id: str
    user_id: str
    category: str
    key: str
    value: str
    source: str
    confidence: float
    last_seen_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TurnAnalysisRead(BaseModel):
    id: str
    user_id: str
    chat_id: str
    user_message_id: str | None = None
    assistant_message_id: str | None = None
    emotion: dict[str, Any] = Field(default_factory=dict)
    tone: dict[str, Any] = Field(default_factory=dict)
    intent: str
    language: str
    personality_mode: dict[str, Any] = Field(default_factory=dict)
    state_delta: dict[str, Any] = Field(default_factory=dict)
    flags: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime

    model_config = {"from_attributes": True}


class HumanStateRead(BaseModel):
    profile: InteractionProfileRead
    memories: list[MemoryRead]
    recent_turns: list[TurnAnalysisRead]
