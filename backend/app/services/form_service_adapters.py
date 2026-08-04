from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
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


class AdapterKillSwitchActive(AdapterError):
    code = "ADAPTER_DISABLED"
    retryable = False


class DemoSubmissionRejected(AdapterError):
    code = "DEMO_REJECTED"
    retryable = False


class AdditionalDocumentRequired(AdapterError):
    code = "ADDITIONAL_DOCUMENT_REQUIRED"
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


class MockPortalAdapter(LocalVerifiedAdapter):
    """Deterministic simulator for the complete AutoAI Seva demo lifecycle."""

    key = "mock_portal"

    def _scenario(self, context: AdapterContext) -> str:
        configured = str((context.adapter.configuration or {}).get("demo_scenario", "success"))
        selected = str(context.fields.get("demo_scenario") or configured).strip().casefold()
        return selected if selected in {"success", "timeout", "rejection", "additional_document", "duplicate"} else "success"

    def prepare(self, context: AdapterContext) -> dict[str, Any]:
        result = super().prepare(context)
        return {
            **result,
            "simulation": True,
            "scenario": self._scenario(context),
            "protected_actions": ["final_confirmation"],
            "government_submission": False,
        }

    def submit(self, context: AdapterContext, idempotency_key: str) -> SubmissionResult:
        scenario = self._scenario(context)
        if scenario == "timeout":
            raise SubmissionOutcomeUnknown("The demo portal timed out after receiving the request")
        if scenario == "rejection":
            raise DemoSubmissionRejected("The demo portal rejected the application for testing")
        if scenario == "additional_document":
            raise AdditionalDocumentRequired("The demo portal requested one additional supporting document")
        # Both success and duplicate use the stable parent implementation. The task-level
        # idempotency record ensures the duplicate scenario cannot create a second receipt.
        return super().submit(context, idempotency_key)

    def consume_secret(self, context: AdapterContext, kind: str, secret: str) -> dict[str, Any]:
        del context
        accepted = (
            (kind == "otp" and secret.isdigit() and len(secret) == 6)
            or (kind == "captcha" and bool(secret.strip()) and len(secret) <= 32)
        )
        return {
            "accepted": accepted,
            "session_status": "VERIFIED" if accepted else "REJECTED",
            "persisted_secret": False,
        }


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


class BiharIncomeAssistedAdapter(GuidedBrowserAdapter):
    """User-assisted Bihar ServicePlus flow; never represents autonomous submission."""

    key = "bihar_income_assisted"

    def availability(self, context: AdapterContext) -> dict[str, Any]:
        result = super().availability(context)
        return {
            **result,
            "mode": "USER_ASSISTED_BROWSER",
            "protected_actions": ["otp", "captcha", "declaration", "final_submit"],
        }

    def prepare(self, context: AdapterContext) -> dict[str, Any]:
        result = super().prepare(context)
        return {
            **result,
            "mode": "USER_ASSISTED_BROWSER",
            "assisted_steps": [
                "Review the prepared applicant information",
                "Open the verified Bihar ServicePlus destination",
                "Enter OTP or login details directly on the official portal",
                "Solve CAPTCHA directly on the official portal",
                "Review the official declaration and submit yourself",
                "Return to AutoAI with the application reference for tracking",
            ],
            "auto_submit": False,
            "government_submission": False,
        }

    def track(self, context: AdapterContext, application_id: str | None) -> dict[str, Any]:
        del context
        return {
            "status": "CHECK_OFFICIAL_PORTAL" if application_id else "AWAITING_APPLICATION_REFERENCE",
            "verified": False,
            "application_id": application_id,
            "message": "Use the official Bihar ServicePlus tracking page and confirm the returned status.",
        }


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
    configuration = record.configuration or {}
    if not record.enabled or configuration.get("kill_switch_active") is True:
        raise AdapterKillSwitchActive("This service adapter has been disabled by the safety kill switch")

    # Adapter keys select narrowly scoped implementations without changing legacy
    # adapter_type values used by existing authorization and submit guards.
    keyed_adapters: dict[str, ServiceAdapter] = {
        "autoai_seva_demo_local_verified": MockPortalAdapter(),
        "bihar_serviceplus_guided": BiharIncomeAssistedAdapter(),
    }
    keyed = keyed_adapters.get(record.adapter_key)
    if keyed:
        return keyed

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
