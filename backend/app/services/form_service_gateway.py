from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.form_service import ServicePortal, ServiceTask, SubmissionConfirmation
from app.services.autoai_seva_review import validate_review_binding
from app.services.form_service_registry import RegistrySecurityError, validate_portal_url
from app.services.trust_gateway import GatewayInput, GatewayStatus, authorize_and_execute


class ServiceDecision(StrEnum):
    ALLOW = "ALLOW"
    DENY = "DENY"
    REQUIRE_PERMISSION = "REQUIRE_PERMISSION"
    REQUIRE_INFORMATION = "REQUIRE_INFORMATION"
    REQUIRE_DOCUMENT = "REQUIRE_DOCUMENT"
    REQUIRE_AUTHENTICATION = "REQUIRE_AUTHENTICATION"
    REQUIRE_CONFIRMATION = "REQUIRE_CONFIRMATION"
    REQUIRE_HUMAN_ACTION = "REQUIRE_HUMAN_ACTION"
    REQUIRE_HANDOFF = "REQUIRE_HANDOFF"


@dataclass(frozen=True)
class ServiceGatewayResult:
    decision: ServiceDecision
    code: str
    explanation: str
    adapter_result: dict[str, Any] | None = None
    trust_receipt_id: str | None = None


def evaluate_task_action(
    db: Session,
    *,
    user_id: str,
    task: ServiceTask,
    action: str,
    confirmation: SubmissionConfirmation | None = None,
) -> ServiceGatewayResult:
    if task.user_id != user_id:
        return ServiceGatewayResult(ServiceDecision.DENY, "POLICY_BLOCKED", "Task ownership validation failed")
    if task.state in {"CANCELLED", "EXPIRED", "FAILED_FINAL", "COMPLETED_VERIFIED"} and action not in {"track", "read"}:
        return ServiceGatewayResult(ServiceDecision.DENY, "POLICY_BLOCKED", f"Action is not allowed from {task.state}")
    if task.expires_at and task.expires_at <= datetime.utcnow():
        return ServiceGatewayResult(ServiceDecision.DENY, "SESSION_EXPIRED", "The task has expired")
    if task.portal_id:
        portal = db.scalar(select(ServicePortal).where(ServicePortal.id == task.portal_id))
        if not portal:
            return ServiceGatewayResult(ServiceDecision.DENY, "PORTAL_UNVERIFIED", "The selected portal is unavailable")
        try:
            validate_portal_url(portal)
        except RegistrySecurityError as exc:
            return ServiceGatewayResult(ServiceDecision.DENY, "PORTAL_UNVERIFIED", str(exc))
    if action == "submit":
        if task.state not in {"SUBMISSION_CONFIRMATION_REQUIRED", "SUBMITTING"}:
            return ServiceGatewayResult(ServiceDecision.REQUIRE_CONFIRMATION, "USER_CONFIRMATION_REQUIRED", "Review and explicit submission confirmation are required")
        if not confirmation or confirmation.user_id != user_id or confirmation.task_id != task.id:
            return ServiceGatewayResult(ServiceDecision.REQUIRE_CONFIRMATION, "USER_CONFIRMATION_REQUIRED", "A valid task confirmation is required")
        if confirmation.status != "CONFIRMED" or confirmation.expires_at <= datetime.utcnow():
            return ServiceGatewayResult(ServiceDecision.REQUIRE_CONFIRMATION, "USER_CONFIRMATION_REQUIRED", "Submission confirmation is missing or expired")
        review_valid, review_explanation = validate_review_binding(db, task, confirmation)
        if not review_valid:
            return ServiceGatewayResult(
                ServiceDecision.REQUIRE_CONFIRMATION,
                "REVIEW_HASH_MISMATCH",
                review_explanation,
            )
    return ServiceGatewayResult(ServiceDecision.ALLOW, "ALLOW", "Service policy checks passed")


def execute_through_trust_gateway(
    db: Session,
    *,
    user_id: str,
    task: ServiceTask,
    confirmation: SubmissionConfirmation,
    idempotency_key: str,
    adapter: Callable[[dict[str, Any]], dict[str, Any]],
) -> ServiceGatewayResult:
    decision = evaluate_task_action(db, user_id=user_id, task=task, action="submit", confirmation=confirmation)
    if decision.decision != ServiceDecision.ALLOW:
        return decision
    # Trust Hub receives a preconfirmed high-risk action only after the service gateway
    # validates ownership, portal origin, the deterministic review hash, and a matching
    # final-consent lease. Emergency-pause and policy enforcement remain centralized.
    result = authorize_and_execute(
        db,
        user_id,
        GatewayInput(
            domain="forms",
            action_type="form.submit",
            payload={
                "task_id": task.id,
                "service_id": task.service_id,
                "requires_network": task.execution_mode in {"ASSIST", "EXECUTE_WITH_CONFIRMATION"},
            },
            resource_id=task.id,
            idempotency_key=idempotency_key,
        ),
        adapter,
        preconfirmed=True,
    )
    if result.status == GatewayStatus.DENIED:
        return ServiceGatewayResult(ServiceDecision.DENY, "POLICY_BLOCKED", result.explanation)
    if result.status == GatewayStatus.CONFIRMATION_REQUIRED:
        return ServiceGatewayResult(ServiceDecision.REQUIRE_CONFIRMATION, "USER_CONFIRMATION_REQUIRED", result.explanation)
    if result.status != GatewayStatus.EXECUTED:
        return ServiceGatewayResult(ServiceDecision.DENY, "ADAPTER_UNAVAILABLE", result.explanation)
    return ServiceGatewayResult(ServiceDecision.ALLOW, "ALLOW", result.explanation, result.adapter_result, result.receipt_id)


def execute_service_action(
    db: Session,
    *,
    user_id: str,
    task: ServiceTask,
    action_type: str,
    idempotency_key: str,
    adapter: Callable[[dict[str, Any]], dict[str, Any]],
    preconfirmed: bool,
) -> ServiceGatewayResult:
    decision = evaluate_task_action(db, user_id=user_id, task=task, action="read")
    if decision.decision != ServiceDecision.ALLOW:
        return decision
    result = authorize_and_execute(
        db,
        user_id,
        GatewayInput(
            domain="forms",
            action_type=action_type,
            payload={"task_id": task.id, "service_id": task.service_id, "requires_network": True},
            resource_id=task.id,
            idempotency_key=idempotency_key,
        ),
        adapter,
        preconfirmed=preconfirmed,
    )
    if result.status == GatewayStatus.DENIED:
        return ServiceGatewayResult(ServiceDecision.DENY, "POLICY_BLOCKED", result.explanation)
    if result.status == GatewayStatus.CONFIRMATION_REQUIRED:
        return ServiceGatewayResult(ServiceDecision.REQUIRE_CONFIRMATION, "USER_CONFIRMATION_REQUIRED", result.explanation)
    if result.status != GatewayStatus.EXECUTED:
        return ServiceGatewayResult(ServiceDecision.DENY, "ADAPTER_UNAVAILABLE", result.explanation)
    return ServiceGatewayResult(ServiceDecision.ALLOW, "ALLOW", result.explanation, result.adapter_result, result.receipt_id)
