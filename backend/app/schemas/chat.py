from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.search import SearchMode


class MessageRead(BaseModel):
    id: str
    role: str
    content: str
    message_metadata: dict | None = Field(default_factory=dict)
    created_at: datetime

    model_config = {"from_attributes": True}


class ChatCreate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    model: str | None = Field(default=None, max_length=120)


class ChatUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    model: str | None = Field(default=None, max_length=120)


class ChatListItem(BaseModel):
    id: str
    title: str
    model: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ChatRead(ChatListItem):
    system_prompt: str | None = None
    messages: list[MessageRead] = Field(default_factory=list)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    chat_id: str | None = None
    title: str | None = Field(default=None, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    mode: Literal["normal", "deep_research", "multi_model"] = "normal"
    providers: list[Literal["groq", "bedrock"]] = Field(default_factory=lambda: ["groq", "bedrock"])
    max_models: int | None = Field(default=None, ge=1, le=12)
    all_models: bool = False
    timeout_seconds: int | None = Field(default=None, ge=5, le=120)
    groq_models: list[str] = Field(default_factory=list)
    bedrock_models: list[str] = Field(default_factory=list)
    final_judge_model: str | None = Field(default=None, max_length=160)
    provider: str | None = Field(default=None, pattern="^(openai|groq|bedrock)$")
    model: str | None = Field(default=None, max_length=120)
    web_search: bool = False
    search_mode: SearchMode = "auto"
    reasoning: bool = False
    document_ids: list[str] = Field(default_factory=list)


class ChatResponse(BaseModel):
    chat: ChatRead
    assistant_message: MessageRead


class ResearchProviderModels(BaseModel):
    enabled: bool
    models: list[str] = Field(default_factory=list)


class ResearchModelDefaults(BaseModel):
    max_models: int
    timeout_seconds: int
    final_judge_model: str | None = None


class ResearchModelOptions(BaseModel):
    providers: dict[Literal["groq", "bedrock"], ResearchProviderModels]
    defaults: ResearchModelDefaults


class CodeAssistRequest(BaseModel):
    mode: str = Field(pattern="^(generate|debug|explain)$")
    prompt: str = Field(min_length=1, max_length=20000)
    code: str | None = Field(default=None, max_length=50000)
    language: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=120)


class CodeAssistResponse(BaseModel):
    content: str
    model: str
