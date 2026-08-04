from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class ToolRisk(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class ToolProposal(BaseModel):
    tool: str = Field(min_length=3, max_length=100)
    task_id: str = Field(min_length=36, max_length=36)
    arguments: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=8, max_length=120)


@dataclass(frozen=True)
class ServiceToolSpec:
    name: str
    risk: ToolRisk
    required_consent: bool
    required_permission: str | None
    timeout_seconds: int
    max_attempts: int
    allowed_states: frozenset[str]


def _spec(name: str, risk: ToolRisk, states: tuple[str, ...], *, consent: bool = True, permission: str | None = None, timeout: int = 30, retries: int = 1) -> ServiceToolSpec:
    return ServiceToolSpec(name, risk, consent, permission, timeout, retries, frozenset(states))


FORM_SERVICE_TOOLS: dict[str, ServiceToolSpec] = {
    item.name: item for item in (
        _spec("discover_service", ToolRisk.LOW, ("CREATED",), consent=False, timeout=5),
        _spec("create_service_task", ToolRisk.LOW, ("CREATED",), consent=False, timeout=5),
        _spec("explain_service_requirements", ToolRisk.LOW, ("CREATED", "REQUIREMENTS_READY"), consent=False, timeout=5),
        _spec("request_user_fields", ToolRisk.LOW, ("COLLECTING_INFORMATION",)),
        _spec("request_secure_input", ToolRisk.HIGH, ("AWAITING_AUTHENTICATION",), timeout=120, retries=0),
        _spec("request_documents", ToolRisk.MEDIUM, ("COLLECTING_DOCUMENTS",)),
        _spec("request_permission", ToolRisk.MEDIUM, ("COLLECTING_DOCUMENTS", "AWAITING_PERMISSION"), permission="action_specific"),
        _spec("inspect_document", ToolRisk.MEDIUM, ("COLLECTING_DOCUMENTS",), timeout=60),
        _spec("extract_document_fields", ToolRisk.MEDIUM, ("COLLECTING_DOCUMENTS",), timeout=60),
        _spec("compare_profile_and_document", ToolRisk.MEDIUM, ("COLLECTING_DOCUMENTS", "VALIDATING")),
        _spec("create_portal_session", ToolRisk.HIGH, ("SUBMISSION_CONFIRMATION_REQUIRED", "FAILED_RECOVERABLE"), timeout=30, retries=0),
        _spec("prepare_form", ToolRisk.MEDIUM, ("READY_TO_PREPARE",), timeout=60),
        _spec("fill_supported_fields", ToolRisk.HIGH, ("PORTAL_SESSION_ACTIVE",), timeout=30),
        _spec("request_human_verification", ToolRisk.HIGH, ("AWAITING_AUTHENTICATION", "AWAITING_USER_ACTION"), retries=0),
        _spec("validate_form", ToolRisk.MEDIUM, ("VALIDATING",), timeout=60),
        _spec("create_review_summary", ToolRisk.MEDIUM, ("VALIDATING", "REVIEW_REQUIRED")),
        _spec("request_submission_confirmation", ToolRisk.HIGH, ("REVIEW_REQUIRED",), retries=0),
        _spec("submit_form", ToolRisk.HIGH, ("SUBMISSION_CONFIRMATION_REQUIRED",), timeout=30, retries=0),
        _spec("verify_submission", ToolRisk.HIGH, ("SUBMITTED_UNVERIFIED", "VERIFYING"), timeout=30, retries=2),
        _spec("create_action_receipt", ToolRisk.MEDIUM, ("SUBMITTED_UNVERIFIED", "VERIFYING", "COMPLETED_VERIFIED")),
        _spec("track_application", ToolRisk.MEDIUM, ("SUBMITTED_UNVERIFIED", "COMPLETED_VERIFIED"), timeout=20, retries=2),
        _spec("pause_task", ToolRisk.LOW, tuple(), consent=False),
        _spec("resume_task", ToolRisk.MEDIUM, ("PAUSED",)),
        _spec("cancel_task", ToolRisk.HIGH, tuple(), retries=0),
        _spec("retry_failed_step", ToolRisk.MEDIUM, ("FAILED_RECOVERABLE", "SUBMITTED_UNVERIFIED"), retries=0),
        _spec("escalate_to_human_agent", ToolRisk.HIGH, ("FAILED_RECOVERABLE", "PORTAL_SESSION_ACTIVE"), retries=0),
    )
}


class ToolPolicyError(ValueError):
    pass


def validate_tool_proposal(proposal: ToolProposal, *, authenticated_user_id: str, task_user_id: str, task_state: str) -> ServiceToolSpec:
    spec = FORM_SERVICE_TOOLS.get(proposal.tool)
    if not spec:
        raise ToolPolicyError("UNSUPPORTED_OPERATION")
    if authenticated_user_id != task_user_id:
        raise ToolPolicyError("POLICY_BLOCKED")
    if spec.allowed_states and task_state not in spec.allowed_states:
        raise ToolPolicyError("POLICY_BLOCKED")
    forbidden = ("password", "otp", "pin", "secret", "cvv", "token", "recovery_code")
    if any(any(item in key.casefold() for item in forbidden) for key in proposal.arguments):
        raise ToolPolicyError("AUTHENTICATION_REQUIRED")
    return spec
