from typing import Any, Literal

from pydantic import BaseModel, Field


AssistantMode = Literal["answer_only", "action_only", "answer_and_action", "clarification_required", "confirmation_required", "unsupported_action", "error"]


class AssistantCommand(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    timezone: str = Field(min_length=1, max_length=80)
    request_id: str = Field(min_length=8, max_length=80)
    context: list[dict[str, str]] = Field(default_factory=list, max_length=12)
    platform: Literal["web", "android", "ios"] = "web"


class AssistantActionItem(BaseModel):
    id: str
    tool_name: str
    arguments: dict[str, Any]
    risk_level: Literal["low", "medium", "high"]
    status: Literal["permission_required", "waiting_confirmation", "executing", "completed", "failed", "cancelled"]
    requires_confirmation: bool
    message: str
    result: dict[str, Any] = Field(default_factory=dict)
    undo_supported: bool = False


class AssistantResponse(BaseModel):
    mode: AssistantMode
    intent: str
    assistant_reply: str
    emotion: dict[str, Any] = Field(default_factory=lambda: {"label": "neutral", "confidence": 0})
    needs_clarification: bool = False
    clarification_question: str | None = None
    actions: list[AssistantActionItem] = Field(default_factory=list)
    model: str
    normalized_user_text: str = ""


class AssistantHistory(BaseModel):
    items: list[AssistantActionItem]
