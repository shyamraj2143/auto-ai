from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class TaskState(StrEnum):
    CREATED = "CREATED"
    INTENT_CONFIRMED = "INTENT_CONFIRMED"
    SERVICE_DISCOVERY = "SERVICE_DISCOVERY"
    REQUIREMENTS_READY = "REQUIREMENTS_READY"
    COLLECTING_INFORMATION = "COLLECTING_INFORMATION"
    COLLECTING_DOCUMENTS = "COLLECTING_DOCUMENTS"
    AWAITING_PERMISSION = "AWAITING_PERMISSION"
    AWAITING_AUTHENTICATION = "AWAITING_AUTHENTICATION"
    READY_TO_PREPARE = "READY_TO_PREPARE"
    PREPARING = "PREPARING"
    PORTAL_SESSION_ACTIVE = "PORTAL_SESSION_ACTIVE"
    AWAITING_USER_ACTION = "AWAITING_USER_ACTION"
    VALIDATING = "VALIDATING"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    SUBMISSION_CONFIRMATION_REQUIRED = "SUBMISSION_CONFIRMATION_REQUIRED"
    SUBMITTING = "SUBMITTING"
    SUBMITTED_UNVERIFIED = "SUBMITTED_UNVERIFIED"
    VERIFYING = "VERIFYING"
    COMPLETED_VERIFIED = "COMPLETED_VERIFIED"
    FAILED_RECOVERABLE = "FAILED_RECOVERABLE"
    FAILED_FINAL = "FAILED_FINAL"
    PAUSED = "PAUSED"
    CANCELLED = "CANCELLED"
    EXPIRED = "EXPIRED"


class ExecutionMode(StrEnum):
    EXPLAIN = "EXPLAIN"
    PREPARE = "PREPARE"
    ASSIST = "ASSIST"
    EXECUTE_WITH_CONFIRMATION = "EXECUTE_WITH_CONFIRMATION"


class CardType(StrEnum):
    SERVICE_PLAN = "service_plan"
    INFORMATION_REQUEST = "information_request"
    SECURE_INPUT_REQUEST = "secure_input_request"
    DOCUMENT_REQUEST = "document_request"
    PERMISSION_REQUEST = "permission_request"
    PORTAL_SESSION = "portal_session"
    USER_ACTION_REQUIRED = "user_action_required"
    FORM_REVIEW = "form_review"
    SUBMISSION_CONFIRMATION = "submission_confirmation"
    TASK_PROGRESS = "task_progress"
    ACTION_RECEIPT = "action_receipt"
    TASK_ERROR = "task_error"
    RECOVERY_OPTIONS = "recovery_options"


class ServiceIntentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    chat_id: str | None = None
    timezone: str = Field(default="UTC", max_length=100)
    locale: str = Field(default="en-IN", max_length=35)
    client_request_id: str = Field(min_length=8, max_length=120)


class ServiceTaskCreate(BaseModel):
    service_id: str = Field(min_length=3, max_length=80)
    chat_id: str | None = None
    original_request: str = Field(min_length=1, max_length=4000)
    execution_mode: ExecutionMode = ExecutionMode.PREPARE
    timezone: str = Field(default="UTC", max_length=100)
    locale: str = Field(default="en-IN", max_length=35)
    client_request_id: str = Field(min_length=8, max_length=120)


class VersionedRequest(BaseModel):
    version: int = Field(ge=1)
    request_id: str = Field(min_length=8, max_length=120)


class TaskActionRequest(VersionedRequest):
    reason: str = Field(default="User requested this action", max_length=500)


class FieldsSubmitRequest(VersionedRequest):
    data_request_id: str
    values: dict[str, Any] = Field(default_factory=dict)

    @field_validator("values")
    @classmethod
    def reject_secrets(cls, values: dict[str, Any]) -> dict[str, Any]:
        forbidden = ("password", "otp", "pin", "secret", "cvv", "token", "recovery_code")
        if any(any(token in key.lower() for token in forbidden) for key in values):
            raise ValueError("Authentication and payment secrets must use the ephemeral secure channel")
        return values


class DocumentAttachRequest(VersionedRequest):
    requirement_id: str
    document_id: str
    save_to_vault: bool = False


class VaultDocumentAttachRequest(VersionedRequest):
    requirement_id: str
    library_asset_id: str


class AnalysisDecisionRequest(VersionedRequest):
    accepted: bool
    accepted_fields: list[str] = Field(default_factory=list, max_length=100)


class DocumentOcrRequest(VersionedRequest):
    cloud_processing_accepted: bool


class PermissionCreateRequest(VersionedRequest):
    capability: Literal["camera", "notifications", "contacts", "calendar", "biometric", "document_picker"]


class PermissionResolveRequest(VersionedRequest):
    native_status: Literal["GRANTED", "DENIED", "PERMANENTLY_DENIED", "UNAVAILABLE", "NOT_REQUIRED"]


class ConsentRequest(VersionedRequest):
    purpose: str = Field(min_length=3, max_length=240)
    data_scope: list[str] = Field(default_factory=list, max_length=100)
    expires_in_minutes: int | None = Field(default=60, ge=1, le=43200)


class PortalSessionRequest(VersionedRequest):
    take_control: bool = False


class PortalOutcomeRequest(VersionedRequest):
    application_id: str | None = Field(default=None, max_length=180)
    transaction_id: str | None = Field(default=None, max_length=180)
    user_reported_status: Literal["submitted", "rejected", "not_submitted", "unknown"]
    idempotency_key: str = Field(min_length=8, max_length=120)


class SecureChallengeRequest(VersionedRequest):
    kind: Literal["otp", "password", "recovery_code", "authentication_token"]


class SecureResponseRequest(BaseModel):
    secret: str = Field(min_length=1, max_length=512, repr=False)
    request_id: str = Field(min_length=8, max_length=120)


class HumanActionRequest(VersionedRequest):
    action: Literal["otp", "password", "captcha", "biometric", "digital_signature", "payment", "consent_declaration", "physical_verification"]
    completed: bool


class ConfirmationRequest(VersionedRequest):
    declaration_accepted: bool
    device_confirmation: Literal["not_required", "confirmed", "unavailable"] = "not_required"


class SubmissionRequest(VersionedRequest):
    confirmation_id: str
    idempotency_key: str = Field(min_length=8, max_length=120)


class HandoffRequest(VersionedRequest):
    approved_field_keys: list[str] = Field(default_factory=list, max_length=100)
    approved_document_ids: list[str] = Field(default_factory=list, max_length=50)
    purpose: str = Field(min_length=3, max_length=240)


class ServiceError(BaseModel):
    code: str
    message: str
    retryable: bool = False
    recovery_actions: list[str] = Field(default_factory=list)
    request_id: str | None = None


class ServiceCard(BaseModel):
    type: CardType
    title: str
    description: str = ""
    state: TaskState
    status: str = "active"
    task_id: str
    task_version: int
    progress_percent: int = Field(ge=0, le=100)
    execution_mode: ExecutionMode
    data: dict[str, Any] = Field(default_factory=dict)
    actions: list[str] = Field(default_factory=list)
    updated_at: datetime


class ServiceTaskView(BaseModel):
    id: str
    chat_id: str | None
    service_id: str
    service_name: str
    provider: str
    state: TaskState
    execution_mode: ExecutionMode
    progress_percent: int
    version: int
    active_card: ServiceCard
    created_at: datetime
    updated_at: datetime


class ServiceIntentResponse(BaseModel):
    handled: bool
    confidence: float = Field(ge=0, le=1)
    reason: str
    chat_id: str | None = None
    task: ServiceTaskView | None = None


class TaskListResponse(BaseModel):
    items: list[ServiceTaskView]
    page: int
    page_size: int
    total: int
    has_more: bool


class ServiceEventView(BaseModel):
    id: str
    event_type: str
    details: dict[str, Any]
    request_id: str
    created_at: datetime
