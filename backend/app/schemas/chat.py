from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_serializer

from app.schemas.search import SearchMode
from app.schemas.feedback import MessageFeedbackRead
from app.utils.datetime import to_rfc3339_utc


ProviderName = Literal["openai", "groq", "nvidia"]
ResearchProviderName = Literal["groq", "nvidia", "openai"]
IntelligenceMode = Literal["instant", "medium", "high", "deep_research", "coding", "normal", "multi_model"]
PresetMode = Literal["auto", "manual"]


class MessageRead(BaseModel):
    id: str
    user_id: str | None = None
    role: str
    content: str
    model: str | None = None
    token_count: int = 0
    message_metadata: dict | None = Field(default_factory=dict)
    feedback: MessageFeedbackRead | None = None
    created_at: datetime

    model_config = {"from_attributes": True}

    @field_serializer("created_at")
    def serialize_created_at(self, value: datetime) -> str:
        return to_rfc3339_utc(value)


class ChatCreate(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    model: str | None = Field(default=None, max_length=120)
    mode: IntelligenceMode = "instant"
    preset_mode: PresetMode = Field(default="auto", alias="presetMode")
    selected_preset: IntelligenceMode = Field(default="instant", alias="selectedPreset")
    manual_preset_locked: bool = Field(default=False, alias="manualPresetLocked")

    model_config = {"populate_by_name": True}


class ChatUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    model: str | None = Field(default=None, max_length=120)
    mode: IntelligenceMode | None = None
    preset_mode: PresetMode | None = Field(default=None, alias="presetMode")
    selected_preset: IntelligenceMode | None = Field(default=None, alias="selectedPreset")
    manual_preset_locked: bool | None = Field(default=None, alias="manualPresetLocked")
    clear_messages: bool = False

    model_config = {"populate_by_name": True}


class ChatListItem(BaseModel):
    id: str
    title: str
    model: str
    mode: str = "normal"
    preset_mode: str = "auto"
    selected_preset: str = "instant"
    manual_preset_locked: bool = False
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

    @field_serializer("created_at", "updated_at")
    def serialize_timestamps(self, value: datetime) -> str:
        return to_rfc3339_utc(value)


class ChatRead(ChatListItem):
    system_prompt: str | None = None
    messages: list[MessageRead] = Field(default_factory=list)


class ChatAttachment(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    type: Literal["image", "file"]
    url: str | None = Field(default=None, max_length=2000)
    preview_url: str | None = Field(default=None, max_length=2000)
    filename: str = Field(min_length=1, max_length=255)
    mime_type: str | None = Field(default=None, max_length=120)
    file_size: int | None = Field(default=None, ge=0)
    status: str | None = Field(default=None, max_length=40)


class MessageInternalContext(BaseModel):
    image_summary: str | None = Field(default=None, max_length=20000)
    ocr_text: str | None = Field(default=None, max_length=20000)
    parsed_file_text: str | None = Field(default=None, max_length=40000)


class ChatRequest(BaseModel):
    message: str = Field(default="", max_length=20000)
    client_message_id: str | None = Field(default=None, max_length=120)
    attachments: list[ChatAttachment] = Field(default_factory=list, max_length=20)
    internal_context: MessageInternalContext | None = None
    chat_id: str | None = Field(default=None, alias="chatId")
    request_id: str | None = Field(default=None, alias="requestId", max_length=120)
    title: str | None = Field(default=None, max_length=160)
    system_prompt: str | None = Field(default=None, max_length=8000)
    mode: IntelligenceMode = "instant"
    preset_mode: PresetMode = Field(default="auto", alias="presetMode")
    preset_source: Literal["auto", "manual"] = Field(default="auto", alias="presetSource")
    selected_preset: IntelligenceMode | None = Field(default=None, alias="selectedPreset")
    detected_preset: IntelligenceMode | None = Field(default=None, alias="detectedPreset")
    manual_preset_locked: bool = Field(default=False, alias="manualPresetLocked")
    providers: list[ResearchProviderName] = Field(default_factory=lambda: ["groq", "nvidia"])
    max_models: int | None = Field(default=None, ge=1)
    all_models: bool = False
    timeout_seconds: int | None = Field(default=None, ge=5, le=120)
    groq_models: list[str] = Field(default_factory=list)
    nvidia_models: list[str] = Field(default_factory=list)
    # Kept for backwards-compatible clients; orchestration does not select OpenAI.
    openai_models: list[str] = Field(default_factory=list)
    # Kept as compatibility fields because older route code may reference them.
    bedrock_models: list[str] = Field(default_factory=list)
    gemini_models: list[str] = Field(default_factory=list)
    final_judge_model: str | None = Field(default=None, max_length=160)
    provider: ProviderName | None = None
    model: str | None = Field(default=None, alias="selectedModel", max_length=120)
    web_search: bool = False
    search_mode: SearchMode = "auto"
    reasoning: bool = False
    document_ids: list[str] = Field(default_factory=list)
    library_asset_ids: list[str] = Field(default_factory=list, max_length=20)
    user_timezone: str | None = Field(default=None, max_length=100)
    user_locale: str | None = Field(default=None, max_length=35)

    model_config = {"populate_by_name": True}


class ChatResponse(BaseModel):
    chat: ChatRead
    assistant_message: MessageRead


class ChatGenerationRead(BaseModel):
    id: str
    chat_id: str
    user_message_id: str | None = None
    assistant_message_id: str | None = None
    status: str
    error: str | None = None
    user_message: MessageRead | None = None
    assistant_message: MessageRead | None = None
    mode: str = "instant"
    activity: list[dict] = Field(default_factory=list)
    activity_summary: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_serializer("created_at", "updated_at", "completed_at")
    def serialize_timestamps(self, value: datetime | None) -> str | None:
        return to_rfc3339_utc(value) if value else None


class ResearchProviderModels(BaseModel):
    enabled: bool
    models: list[str] = Field(default_factory=list)


class ResearchModelDefaults(BaseModel):
    max_models: int
    timeout_seconds: int
    final_judge_model: str | None = None


class ResearchModelOptions(BaseModel):
    providers: dict[ResearchProviderName, ResearchProviderModels]
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


class ChatRegenerateRequest(BaseModel):
    message_id: str | None = None
    mode: IntelligenceMode = "instant"
    providers: list[ResearchProviderName] = Field(default_factory=lambda: ["groq", "nvidia"])
    max_models: int | None = Field(default=None, ge=1)
    all_models: bool = False
    timeout_seconds: int | None = Field(default=None, ge=5, le=120)
    groq_models: list[str] = Field(default_factory=list)
    nvidia_models: list[str] = Field(default_factory=list)
    openai_models: list[str] = Field(default_factory=list)
    bedrock_models: list[str] = Field(default_factory=list)
    gemini_models: list[str] = Field(default_factory=list)
    final_judge_model: str | None = Field(default=None, max_length=160)
    provider: ProviderName | None = None
    model: str | None = Field(default=None, max_length=120)
    web_search: bool = False
    search_mode: SearchMode = "auto"
    reasoning: bool = False
    document_ids: list[str] = Field(default_factory=list)
    user_timezone: str | None = Field(default=None, max_length=100)
    user_locale: str | None = Field(default=None, max_length=35)
