import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.trust_hub import HubActionReceipt, HubAuthoritySetting, HubConsentLease, HubConstraint, HubEmergencyPause, HubPolicyRule, TrustActionRequest, TrustAuditEvent
from app.services.trust_hub_service import evaluate_policy, lease_active

class GatewayStatus(StrEnum):
    DENIED = "DENIED"; CONFIRMATION_REQUIRED = "CONFIRMATION_REQUIRED"; AUTHORIZED = "AUTHORIZED"; EXECUTED = "EXECUTED"; FAILED = "FAILED"

class RiskLevel(StrEnum):
    LOW = "LOW"; MEDIUM = "MEDIUM"; HIGH = "HIGH"; CRITICAL = "CRITICAL"

RISK: dict[str, RiskLevel] = {
    "alarm.create": RiskLevel.LOW, "alarm.list": RiskLevel.LOW, "alarm.update": RiskLevel.MEDIUM, "alarm.disable": RiskLevel.MEDIUM, "alarm.delete": RiskLevel.HIGH,
    "message.send": RiskLevel.HIGH, "call.start": RiskLevel.HIGH, "commitment.create": RiskLevel.MEDIUM, "commitment.accept": RiskLevel.HIGH, "commitment.start": RiskLevel.LOW, "commitment.submit_evidence": RiskLevel.MEDIUM, "commitment.verify": RiskLevel.HIGH, "commitment.cancel": RiskLevel.HIGH, "commitment.reject": RiskLevel.LOW, "commitment.renegotiate": RiskLevel.MEDIUM, "notification.schedule": RiskLevel.MEDIUM,
    "form.submit": RiskLevel.HIGH, "form.portal.open": RiskLevel.MEDIUM, "form.document.ocr": RiskLevel.MEDIUM, "form.handoff": RiskLevel.HIGH,
}

@dataclass(frozen=True)
class GatewayInput:
    domain: str; action_type: str; payload: dict[str, Any]; idempotency_key: str
    resource_id: str | None = None; required_capability: str | None = None; essential: bool = False

@dataclass(frozen=True)
class GatewayResult:
    status: GatewayStatus; action_request_id: str; explanation: str; receipt_id: str | None = None; confirmation_token: str | None = None; adapter_result: dict[str, Any] | None = None

def _audit(db: Session, request: TrustActionRequest, event_type: str, details: dict[str, Any]) -> None:
    previous = db.scalar(select(TrustAuditEvent).where(TrustAuditEvent.user_id == request.user_id).order_by(TrustAuditEvent.created_at.desc(), TrustAuditEvent.id.desc()).limit(1))
    previous_hash = previous.event_hash if previous else ""
    canonical = json.dumps({"request": request.id, "type": event_type, "details": details, "previous": previous_hash}, sort_keys=True, separators=(",", ":"), default=str)
    db.add(TrustAuditEvent(user_id=request.user_id, action_request_id=request.id, event_type=event_type, details=details, previous_hash=previous_hash, event_hash=hashlib.sha256(canonical.encode()).hexdigest()))

def _authority(db: Session, user_id: str, domain: str) -> str:
    setting = db.scalar(select(HubAuthoritySetting).where(HubAuthoritySetting.user_id == user_id, HubAuthoritySetting.domain == domain))
    return setting.level if setting else "EXECUTE_AND_REPORT"

def authorize_and_execute(db: Session, user_id: str, proposal: GatewayInput, adapter: Callable[[dict[str, Any]], dict[str, Any]], *, confirmed_token: str | None = None, preconfirmed: bool = False) -> GatewayResult:
    existing = db.scalar(select(TrustActionRequest).where(TrustActionRequest.user_id == user_id, TrustActionRequest.idempotency_key == proposal.idempotency_key))
    if existing and existing.status in {"EXECUTED", "DENIED", "FAILED"}:
        receipt = db.scalar(select(HubActionReceipt).where(HubActionReceipt.request_id == existing.idempotency_key, HubActionReceipt.user_id == user_id))
        return GatewayResult(GatewayStatus(existing.status), existing.id, "Idempotent replay returned the original result.", receipt.id if receipt else None)
    risk = RISK.get(proposal.action_type, RiskLevel.HIGH)
    request = existing or TrustActionRequest(user_id=user_id, domain=proposal.domain, action_type=proposal.action_type, resource_id=proposal.resource_id, normalized_payload=proposal.payload, risk_level=risk.value, idempotency_key=proposal.idempotency_key)
    if not existing: db.add(request); db.flush()
    pause = db.get(HubEmergencyPause, user_id)
    rules = list(db.scalars(select(HubPolicyRule).where(HubPolicyRule.user_id == user_id, HubPolicyRule.domain == proposal.domain)))
    policy = evaluate_policy(rules, {**proposal.payload, "action_type": proposal.action_type, "risk_level": risk.value})
    if not policy["matched_policy_ids"] and proposal.action_type in RISK and risk == RiskLevel.LOW:
        policy = {**policy, "decision": "ALLOW", "explanation": "Known low-risk action is allowed when no user policy overrides it."}
    reasons: list[str] = []
    if pause and pause.active and (not pause.expires_at or pause.expires_at > datetime.utcnow()) and not proposal.essential: reasons.append("Emergency pause blocks nonessential AI actions.")
    if policy["decision"] == "DENY": reasons.append(policy["explanation"])
    if proposal.required_capability:
        leases = list(db.scalars(select(HubConsentLease).where(HubConsentLease.user_id == user_id, HubConsentLease.capability == proposal.required_capability)))
        if not any(lease_active(lease) for lease in leases): reasons.append("No active consent lease with the required OS permission.")
    now = datetime.utcnow()
    constraints = list(db.scalars(select(HubConstraint).where(HubConstraint.user_id == user_id, HubConstraint.hard.is_(True))))
    for constraint in constraints:
        if constraint.expires_at and constraint.expires_at <= now: continue
        if constraint.kind == "CONNECTIVITY" and proposal.payload.get("requires_network") and constraint.value.get("online") is False: reasons.append("A hard offline constraint blocks this network action.")
    if reasons:
        request.status = "DENIED"; request.decision_json = {"policy": policy, "reasons": reasons}; _audit(db, request, "ACTION_DENIED", {"reasons": reasons}); db.commit()
        return GatewayResult(GatewayStatus.DENIED, request.id, " ".join(reasons))
    authority = _authority(db, user_id, proposal.domain)
    confirmation_required = policy["decision"] in {"REQUIRE_CONFIRMATION", "REQUIRE_BIOMETRIC"} or authority in {"SUGGEST_ONLY", "PREPARE_AND_ASK", "EXECUTE_AFTER_CONFIRMATION"} or risk in {RiskLevel.HIGH, RiskLevel.CRITICAL}
    if confirmation_required:
        valid = preconfirmed or (confirmed_token and request.confirmation_token and secrets.compare_digest(hashlib.sha256(confirmed_token.encode()).hexdigest(), request.confirmation_token) and request.confirmation_expires_at and request.confirmation_expires_at > now)
        if not valid:
            token = secrets.token_urlsafe(24); request.confirmation_token = hashlib.sha256(token.encode()).hexdigest(); request.confirmation_expires_at = now + timedelta(minutes=5); request.status = "CONFIRMATION_REQUIRED"; request.decision_json = {"policy": policy, "authority": authority, "risk": risk.value}; _audit(db, request, "CONFIRMATION_REQUIRED", request.decision_json); db.commit()
            return GatewayResult(GatewayStatus.CONFIRMATION_REQUIRED, request.id, "Explicit confirmation is required.", confirmation_token=token)
    request.status = "AUTHORIZED"; _audit(db, request, "ACTION_AUTHORIZED", {"policy": policy, "authority": authority, "risk": risk.value, "confirmation": "assistant_action_log" if preconfirmed else "gateway_token" if confirmed_token else "not_required"}); db.flush()
    receipt = HubActionReceipt(user_id=user_id, action_type=proposal.action_type, status="DISPATCHED", explanation="Authorized by the Trust Decision Gateway; awaiting verification.", evidence_strength="WEAK", request_id=proposal.idempotency_key); db.add(receipt); db.flush()
    try:
        result = adapter(proposal.payload)
        request.status = "EXECUTED"; receipt.status = "SUCCEEDED_UNVERIFIED"; _audit(db, request, "ADAPTER_ACKNOWLEDGED", {"receipt_id": receipt.id, "provider_id": result.get("id")}); db.commit()
        return GatewayResult(GatewayStatus.EXECUTED, request.id, "Adapter acknowledged the action; outcome remains unverified.", receipt.id, adapter_result=result)
    except Exception as exc:
        request.status = "FAILED"; receipt.status = "FAILED_RETRYABLE"; receipt.explanation = f"Adapter failed: {type(exc).__name__}"; _audit(db, request, "ADAPTER_FAILED", {"error_type": type(exc).__name__}); db.commit(); raise
