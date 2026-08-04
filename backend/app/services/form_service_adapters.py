from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from app.core.config import settings
from app.models.form_service import PortalAdapterRecord, ServiceDefinition, ServicePortal, ServiceTask


class AdapterError(RuntimeError):
    code = "ADAPTER_UNAVAILABLE"
    retryable = True


class UnsupportedAdapterOperation(AdapterError):
    code = "UNSUPPORTED_OPERATION"
    retryable = False


class SubmissionOutcomeUnknown(AdapterError):
    code = "SUBMISSION_UNVERIFIED"
    retryable = True


@dataclass(frozen=True)
class AdapterContext:
    task: ServiceTask
    service: ServiceDefinition
    portal: ServicePortal | None
    adapter: PortalAdapterRecord
    fields: dict[str, Any]
    documents: list[dict[str, Any]]


@dataclass(frozen=True)
class SubmissionResult:
    acknowledged: bool
    adapter_reference: str
    application_id: str | None
    transaction_id: str | None
    evidence_type: str | None
    evidence_reference: str | None
    evidence_checksum: str | None
    verified: bool
    expected_timeline: str | None


class ServiceAdapter(Protocol):
    key: str

    def availability(self, context: AdapterContext) -> dict[str, Any]: ...
    def prepare(self, context: AdapterContext) -> dict[str, Any]: ...
    def validate(self, context: AdapterContext) -> list[str]: ...
    def submit(self, context: AdapterContext, idempotency_key: str) -> SubmissionResult: ...
    def verify(self, context: AdapterContext, result: SubmissionResult) -> SubmissionResult: ...
    def track(self, context: AdapterContext, application_id: str | None) -> dict[str, Any]: ...
    def consume_secret(self, context: AdapterContext, kind: str, secret: str) -> dict[str, Any]: ...


class BaseAdapter:
    key = "base"

    def availability(self, context: AdapterContext) -> dict[str, Any]:
        return {"available": True, "mode": context.adapter.adapter_type}

    def prepare(self, context: AdapterContext) -> dict[str, Any]:
        return {"field_count": len(context.fields), "document_count": len(context.documents)}

    def validate(self, context: AdapterContext) -> list[str]:
        return []

    def submit(self, context: AdapterContext, idempotency_key: str) -> SubmissionResult:
        del context, idempotency_key
        raise UnsupportedAdapterOperation("This service requires guided completion on the official portal")

    def verify(self, context: AdapterContext, result: SubmissionResult) -> SubmissionResult:
        del context
        return result

    def track(self, context: AdapterContext, application_id: str | None) -> dict[str, Any]:
        del context, application_id
        return {"status": "GUIDED_ONLY", "verified": False, "message": "Check status on the official portal."}

    def consume_secret(self, context: AdapterContext, kind: str, secret: str) -> dict[str, Any]:
        del context, kind, secret
        raise UnsupportedAdapterOperation("Enter authentication details directly on the official portal")


class LocalVerifiedAdapter(BaseAdapter):
    key = "local_verified"

    def validate(self, context: AdapterContext) -> list[str]:
        required = {item["key"] for item in context.service.requirements if item.get("required")}
        return [f"Missing required field: {key}" for key in sorted(required - context.fields.keys())]

    def submit(self, context: AdapterContext, idempotency_key: str) -> SubmissionResult:
        errors = self.validate(context)
        if errors:
            raise AdapterError("; ".join(errors))
        if (context.adapter.configuration or {}).get("submission_outcome") == "unknown":
            raise SubmissionOutcomeUnknown("The safe adapter intentionally returned an unknown outcome")
        stable = hashlib.sha256(f"{context.task.user_id}:{context.task.id}:{idempotency_key}".encode()).hexdigest()
        application_id = f"AUTOAI-TEST-{stable[:12].upper()}"
        transaction_id = f"TX-{stable[12:28].upper()}"
        evidence_payload = f"{application_id}:{transaction_id}:{context.task.id}"
        signature = hmac.new(settings.jwt_secret_key.encode(), evidence_payload.encode(), hashlib.sha256).hexdigest()
        return SubmissionResult(
            acknowledged=True,
            adapter_reference=stable,
            application_id=application_id,
            transaction_id=transaction_id,
            evidence_type="signed_local_adapter_response",
            evidence_reference=f"autoai:test-receipt:{application_id}:{signature}",
            evidence_checksum=hashlib.sha256(evidence_payload.encode()).hexdigest(),
            verified=True,
            expected_timeline="Immediate test verification",
        )

    def track(self, context: AdapterContext, application_id: str | None) -> dict[str, Any]:
        del context
        return {"status": "COMPLETED_VERIFIED", "verified": bool(application_id), "application_id": application_id}

    def consume_secret(self, context: AdapterContext, kind: str, secret: str) -> dict[str, Any]:
        del context
        accepted = kind == "otp" and secret.isdigit() and len(secret) == 6
        return {"accepted": accepted, "session_status": "VERIFIED" if accepted else "REJECTED"}


class GuidedBrowserAdapter(BaseAdapter):
    key = "guided_browser"

    def availability(self, context: AdapterContext) -> dict[str, Any]:
        return {
            "available": context.portal is not None and context.portal.verified,
            "mode": "GUIDED_ONLY",
            "official_origin": context.portal.origin if context.portal else None,
        }

    def prepare(self, context: AdapterContext) -> dict[str, Any]:
        result = super().prepare(context)
        return {**result, "guided_only": True, "portal_url": context.portal.entry_url if context.portal else None}


class OfficialApiAdapter(BaseAdapter):
    key = "official_api"

    def availability(self, context: AdapterContext) -> dict[str, Any]:
        configured = bool((context.adapter.configuration or {}).get("credential_reference"))
        return {"available": configured, "mode": "OFFICIAL_API", "reason": None if configured else "Provider credentials are not configured"}


class HumanHandoffAdapter(BaseAdapter):
    key = "human_handoff"

    def availability(self, context: AdapterContext) -> dict[str, Any]:
        del context
        return {"available": True, "mode": "HUMAN_HANDOFF", "requires_user_approval": True}


def adapter_for(record: PortalAdapterRecord) -> ServiceAdapter:
    adapters: dict[str, ServiceAdapter] = {
        "local_verified": LocalVerifiedAdapter(),
        "guided_browser": GuidedBrowserAdapter(),
        "official_api": OfficialApiAdapter(),
        "human_handoff": HumanHandoffAdapter(),
    }
    adapter = adapters.get(record.adapter_type)
    if not adapter:
        raise AdapterError(f"Unknown adapter type: {record.adapter_type}")
    return adapter
