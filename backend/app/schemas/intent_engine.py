from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ActionType(StrEnum):
    REPLY_ONLY="REPLY_ONLY"; ASK_CLARIFICATION="ASK_CLARIFICATION"; COLLECT_INFORMATION="COLLECT_INFORMATION"; COLLECT_DOCUMENT="COLLECT_DOCUMENT"; REQUEST_PERMISSION="REQUEST_PERMISSION"; REQUEST_SECURE_INPUT="REQUEST_SECURE_INPUT"; PREPARE_ACTION="PREPARE_ACTION"; EXECUTE_ACTION="EXECUTE_ACTION"; CREATE_AUTOMATION="CREATE_AUTOMATION"; UPDATE_AUTOMATION="UPDATE_AUTOMATION"; CANCEL_ACTION="CANCEL_ACTION"; TRACK_ACTION="TRACK_ACTION"; RESUME_WORKFLOW="RESUME_WORKFLOW"; ESCALATE_TO_HUMAN="ESCALATE_TO_HUMAN"; UNSUPPORTED="UNSUPPORTED"

class RouterOutcome(StrEnum):
    TEXT_RESPONSE="TEXT_RESPONSE"; DYNAMIC_UI_REQUEST="DYNAMIC_UI_REQUEST"; TOOL_EXECUTION_REQUEST="TOOL_EXECUTION_REQUEST"; WORKFLOW_CREATION="WORKFLOW_CREATION"; WORKFLOW_CONTINUATION="WORKFLOW_CONTINUATION"; HUMAN_CONFIRMATION_REQUIRED="HUMAN_CONFIRMATION_REQUIRED"; HUMAN_AUTHENTICATION_REQUIRED="HUMAN_AUTHENTICATION_REQUIRED"; HUMAN_HANDOFF_REQUIRED="HUMAN_HANDOFF_REQUIRED"; UNSUPPORTED_CAPABILITY="UNSUPPORTED_CAPABILITY"

class RiskLevel(StrEnum):
    LOW="LOW"; MEDIUM="MEDIUM"; HIGH="HIGH"; CRITICAL="CRITICAL"

class IntentClassification(BaseModel):
    model_config=ConfigDict(extra="forbid")
    domain: str = Field(min_length=1, max_length=64)
    primary_intent: str = Field(min_length=1, max_length=100)
    secondary_intent: str | None = Field(default=None, max_length=100)
    action_type: ActionType
    entities: dict[str, Any] = Field(default_factory=dict)
    corrections: dict[str, Any] = Field(default_factory=dict)
    references: list[str] = Field(default_factory=list, max_length=20)
    missing_requirements: list[str] = Field(default_factory=list, max_length=50)
    required_capabilities: list[str] = Field(default_factory=list, max_length=30)
    confidence: float = Field(ge=0, le=1)
    urgency: Literal["LOW","NORMAL","HIGH","EMERGENCY"] = "NORMAL"
    risk_level: RiskLevel = RiskLevel.LOW
    requested_autonomy: Literal["NONE","GUIDED","PREPARE","EXECUTE","AUTOMATE"] = "NONE"
    clarification_required: bool = False
    workflow_id: str | None = None

class ValidationRule(BaseModel):
    model_config=ConfigDict(extra="forbid")
    minLength: int | None = Field(default=None, ge=0, le=10000)
    maxLength: int | None = Field(default=None, ge=1, le=10000)
    pattern: str | None = Field(default=None, max_length=200)
    min: float | None = None
    max: float | None = None

class InteractionField(BaseModel):
    model_config=ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    type: Literal["text","email","phone","number","date","time","address","select","multiselect","radio","checkbox","textarea","file","camera","pdf","image","signature","secure_password","otp","captcha","biometric","permission","review","confirmation","progress","receipt"]
    label: str = Field(min_length=1, max_length=160)
    required: bool = False
    options: list[str] = Field(default_factory=list, max_length=100)
    validation: ValidationRule | None = None

class DynamicInteraction(BaseModel):
    model_config=ConfigDict(extra="forbid")
    type: Literal["clarification","intent_confirmation","information_request","document_request","secure_input","permission_request","action_plan","workflow_progress","human_action","final_confirmation","action_receipt","automation_proposal","recoverable_error"]
    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=1000)
    fields: list[InteractionField] = Field(default_factory=list, max_length=50)
    actions: list[Literal["submit","confirm","cancel","retry","undo","pause","authenticate"]] = Field(default_factory=list, max_length=8)
    workflow_id: str | None = None

class PolicyDecision(BaseModel):
    model_config=ConfigDict(extra="forbid")
    outcome: RouterOutcome
    reason: str = Field(min_length=1, max_length=500)
    user_message: str = Field(min_length=1, max_length=2000)
    interaction: DynamicInteraction | None = None
    tool_name: str | None = None
    requires_confirmation: bool = False

class IntentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    chat_id: str | None = None
    timezone: str = Field(default="UTC", max_length=64)
    locale: str = Field(default="en", max_length=32)
    platform: Literal["web","android","ios"] = "web"
    device_capabilities: list[str] = Field(default_factory=list, max_length=100)
    granted_permissions: list[str] = Field(default_factory=list, max_length=100)
    client_request_id: str = Field(min_length=8, max_length=100)

class IntentResponse(BaseModel):
    event_id: str
    intent: IntentClassification
    decision: PolicyDecision
    workflow_id: str | None = None

class WorkflowStep(BaseModel):
    model_config=ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    type: Literal["collect_information","collect_document","request_permission","call_tool","condition","branch","wait","notify","request_confirmation","request_authentication","create_reminder","call_api","open_supported_app","open_official_portal","human_handoff","create_receipt"]
    tool: str | None = Field(default=None, max_length=100)
    next: str | None = Field(default=None, max_length=64)
    timeout_seconds: int = Field(default=60, ge=1, le=900)
    configuration: dict[str, Any] = Field(default_factory=dict)

class WorkflowDefinitionSchema(BaseModel):
    model_config=ConfigDict(extra="forbid")
    workflow_name: str = Field(min_length=1, max_length=160)
    version: int = Field(default=1, ge=1)
    trigger: dict[str, Any]
    requirements: list[str] = Field(default_factory=list, max_length=100)
    steps: list[WorkflowStep] = Field(min_length=1, max_length=50)
    @model_validator(mode="after")
    def unique_steps(self):
        ids=[s.id for s in self.steps]
        if len(ids)!=len(set(ids)): raise ValueError("Workflow step ids must be unique")
        if any(s.next and s.next not in ids for s in self.steps): raise ValueError("Workflow contains an unknown next step")
        return self

class InteractionSubmission(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
    decision: Literal["submit","confirm","cancel","retry","pause"] = "submit"

class SecureChallengeCreate(BaseModel):
    workflow_id: str
    kind: Literal["otp","password","oauth","passkey"]
    destination: str = Field(min_length=1, max_length=320)
    expires_in_seconds: int = Field(default=300, ge=30, le=600)

class SecureChallengeSubmit(BaseModel):
    secret: str = Field(min_length=1, max_length=2048)

class FeedbackCreate(BaseModel):
    intent_event_id: str | None = None
    event_type: Literal["intent_corrected","action_correct","information_wrong","action_result","remember_preference","reject_memory"]
    payload: dict[str, Any] = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def no_secrets(cls, value):
        forbidden={"password","otp","pin","secret","document_content","identity_number"}
        if forbidden & {str(k).lower() for k in value}: raise ValueError("Sensitive values are not accepted")
        return value
