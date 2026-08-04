from __future__ import annotations

import base64
import json
import os
import re
import threading
from dataclasses import dataclass
from urllib import error, parse, request


VERIFY_SERVICE_PATTERN = re.compile(r"^VA[0-9a-fA-F]{32}$")
DEFAULT_VERIFY_FRIENDLY_NAME = "AutoAI Phone Verification"
VERIFY_BASE_URL = "https://verify.twilio.com/v2"


@dataclass(frozen=True)
class PhoneVerificationResult:
    ok: bool
    status: str
    detail: str


class PhoneVerificationService:
    """Twilio Verify-backed phone verification without storing or logging OTP values.

    The service automatically repairs a common configuration mistake where a SID from
    another Twilio product (for example a JM/MG SID) is placed in
    TWILIO_VERIFY_SERVICE_SID. A valid Verify Service SID always uses the VA prefix.
    """

    def __init__(self) -> None:
        self._resolved_service_sid: str | None = None
        self._service_lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(
            os.getenv("TWILIO_ACCOUNT_SID", "").strip()
            and os.getenv("TWILIO_AUTH_TOKEN", "").strip()
        )

    def _credentials(self) -> tuple[str, str]:
        account_sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
        auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
        if not account_sid or not auth_token:
            raise RuntimeError("SMS verification is not configured on the server yet.")
        return account_sid, auth_token

    def _headers(self) -> dict[str, str]:
        account_sid, auth_token = self._credentials()
        credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        return {
            "Accept": "application/json",
            "Authorization": f"Basic {credentials}",
            "User-Agent": "AutoAI-Phone-Verification/2.0",
        }

    def _request_json(
        self,
        url: str,
        *,
        method: str = "GET",
        payload: dict[str, str] | None = None,
    ) -> dict[str, object]:
        headers = self._headers()
        body: bytes | None = None
        if payload is not None:
            body = parse.urlencode(payload).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"

        req = request.Request(url, data=body, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=20) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except error.HTTPError as exc:
            provider_code = ""
            provider_message = ""
            try:
                response_payload = json.loads(exc.read().decode("utf-8", errors="replace"))
                provider_code = str(response_payload.get("code") or "")
                provider_message = str(response_payload.get("message") or "")
            except Exception:
                pass

            if exc.code in {401, 403}:
                raise RuntimeError("SMS provider authentication failed. Check the Twilio account credentials.") from exc
            if exc.code == 429:
                raise RuntimeError("Too many OTP requests. Wait a moment and try again.") from exc
            if exc.code == 404:
                raise RuntimeError("TWILIO_VERIFY_RESOURCE_NOT_FOUND") from exc
            if provider_code in {"60200", "60203"}:
                raise RuntimeError("Enter a valid mobile number in international format.") from exc
            if provider_code in {"60202", "20429"}:
                raise RuntimeError("Too many OTP requests. Wait before requesting another code.") from exc
            if provider_message:
                raise RuntimeError("The SMS provider could not process this verification request.") from exc
            raise RuntimeError("The SMS provider temporarily rejected the verification request.") from exc
        except error.URLError as exc:
            raise RuntimeError("SMS provider is temporarily unreachable.") from exc

    def _service_exists(self, service_sid: str) -> bool:
        try:
            payload = self._request_json(f"{VERIFY_BASE_URL}/Services/{parse.quote(service_sid)}")
        except RuntimeError as exc:
            if str(exc) == "TWILIO_VERIFY_RESOURCE_NOT_FOUND":
                return False
            raise
        returned_sid = str(payload.get("sid") or "")
        return returned_sid == service_sid

    def _find_existing_service(self, friendly_name: str) -> str | None:
        payload = self._request_json(f"{VERIFY_BASE_URL}/Services?PageSize=1000")
        services = payload.get("services")
        if not isinstance(services, list):
            return None
        for item in services:
            if not isinstance(item, dict):
                continue
            sid = str(item.get("sid") or "")
            name = str(item.get("friendly_name") or "")
            if name == friendly_name and VERIFY_SERVICE_PATTERN.fullmatch(sid):
                return sid
        return None

    def _create_service(self, friendly_name: str) -> str:
        payload = self._request_json(
            f"{VERIFY_BASE_URL}/Services",
            method="POST",
            payload={"FriendlyName": friendly_name},
        )
        sid = str(payload.get("sid") or "")
        if not VERIFY_SERVICE_PATTERN.fullmatch(sid):
            raise RuntimeError("Twilio did not return a valid Verify Service identifier.")
        return sid

    def _resolve_service_sid(self, *, ignore_configured_sid: bool = False) -> str:
        if self._resolved_service_sid and not ignore_configured_sid:
            return self._resolved_service_sid

        with self._service_lock:
            if self._resolved_service_sid and not ignore_configured_sid:
                return self._resolved_service_sid

            configured_sid = os.getenv("TWILIO_VERIFY_SERVICE_SID", "").strip()
            if (
                not ignore_configured_sid
                and VERIFY_SERVICE_PATTERN.fullmatch(configured_sid)
                and self._service_exists(configured_sid)
            ):
                self._resolved_service_sid = configured_sid
                return configured_sid

            friendly_name = (
                os.getenv("TWILIO_VERIFY_FRIENDLY_NAME", "").strip()
                or DEFAULT_VERIFY_FRIENDLY_NAME
            )
            existing_sid = self._find_existing_service(friendly_name)
            resolved_sid = existing_sid or self._create_service(friendly_name)
            self._resolved_service_sid = resolved_sid
            return resolved_sid

    def _post_to_service(self, resource: str, payload: dict[str, str]) -> dict[str, object]:
        service_sid = self._resolve_service_sid()
        url = f"{VERIFY_BASE_URL}/Services/{parse.quote(service_sid)}/{resource}"
        try:
            return self._request_json(url, method="POST", payload=payload)
        except RuntimeError as exc:
            if str(exc) != "TWILIO_VERIFY_RESOURCE_NOT_FOUND":
                raise

        # A configured VA SID may have been deleted. Repair it once by finding or
        # creating the AutoAI Verify service, then repeat the original operation.
        self._resolved_service_sid = None
        repaired_sid = self._resolve_service_sid(ignore_configured_sid=True)
        repaired_url = f"{VERIFY_BASE_URL}/Services/{parse.quote(repaired_sid)}/{resource}"
        try:
            return self._request_json(repaired_url, method="POST", payload=payload)
        except RuntimeError as exc:
            if str(exc) == "TWILIO_VERIFY_RESOURCE_NOT_FOUND":
                raise RuntimeError("Unable to initialize the SMS verification service.") from exc
            raise

    def send_code(self, phone_number: str) -> PhoneVerificationResult:
        payload = self._post_to_service(
            "Verifications",
            {"To": phone_number, "Channel": "sms"},
        )
        status = str(payload.get("status") or "pending")
        return PhoneVerificationResult(
            ok=status in {"pending", "approved"},
            status=status,
            detail=(
                "Verification code sent."
                if status in {"pending", "approved"}
                else "Unable to send verification code."
            ),
        )

    def check_code(self, phone_number: str, code: str) -> PhoneVerificationResult:
        try:
            payload = self._post_to_service(
                "VerificationCheck",
                {"To": phone_number, "Code": code},
            )
        except RuntimeError as exc:
            if str(exc) == "TWILIO_VERIFY_RESOURCE_NOT_FOUND":
                return PhoneVerificationResult(
                    ok=False,
                    status="expired",
                    detail="The verification code is incorrect or expired. Request a new code.",
                )
            raise
        status = str(payload.get("status") or "pending")
        approved = status == "approved"
        return PhoneVerificationResult(
            ok=approved,
            status=status,
            detail=(
                "Mobile number verified."
                if approved
                else "The verification code is incorrect or expired."
            ),
        )


phone_verification_service = PhoneVerificationService()
