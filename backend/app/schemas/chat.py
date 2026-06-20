from datetime import datetime

from pydantic import BaseModel, Field


class MessageRead(BaseModel):
    id: str
    role: str
    content: str
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
    provider: str | None = Field(default=None, pattern="^(openai|groq|bedrock)$")
    model: str | None = Field(default=None, max_length=120)
    web_search: bool = False
    reasoning: bool = False
    document_ids: list[str] = Field(default_factory=list)


class ChatResponse(BaseModel):
    chat: ChatRead
    assistant_message: MessageRead


class CodeAssistRequest(BaseModel):
    mode: str = Field(pattern="^(generate|debug|explain)$")
    prompt: str = Field(min_length=1, max_length=20000)
    code: str | None = Field(default=None, max_length=50000)
    language: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=120)


class CodeAssistResponse(BaseModel):
    content: str
    model: str
