from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from urllib import error, parse, request


@dataclass(frozen=True)
class PhoneVerificationResult:
    ok: bool
    status: str
    detail: str


class PhoneVerificationService:
    """Twilio Verify-backed phone verification without storing or logging OTP values."""

    @property
    def configured(self) -> bool:
        return all(
            (
                os.getenv("TWILIO_ACCOUNT_SID", "").strip(),
                os.getenv("TWILIO_AUTH_TOKEN", "").strip(),
                os.getenv("TWILIO_VERIFY_SERVICE_SID", "").strip(),
            )
        )

    def _post(self, resource: str, payload: dict[str, str]) -> dict[str, object]:
        account_sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
        auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
        service_sid = os.getenv("TWILIO_VERIFY_SERVICE_SID", "").strip()
        if not account_sid or not auth_token or not service_sid:
            raise RuntimeError("SMS verification is not configured.")

        url = f"https://verify.twilio.com/v2/Services/{parse.quote(service_sid)}/{resource}"
        credentials = base64.b64encode(f"{account_sid}:{auth_token}".encode()).decode()
        req = request.Request(
            url,
            data=parse.urlencode(payload).encode(),
            headers={
                "Accept": "application/json",
                "Authorization": f"Basic {credentials}",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "AutoAI-Phone-Verification/1.0",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            try:
                body = json.loads(exc.read().decode("utf-8", errors="replace"))
                message = str(body.get("message") or "SMS provider rejected the request.")
            except Exception:
                message = "SMS provider rejected the request."
            raise RuntimeError(message) from exc
        except error.URLError as exc:
            raise RuntimeError("SMS provider is temporarily unreachable.") from exc

    def send_code(self, phone_number: str) -> PhoneVerificationResult:
        payload = self._post("Verifications", {"To": phone_number, "Channel": "sms"})
        status = str(payload.get("status") or "pending")
        return PhoneVerificationResult(
            ok=status in {"pending", "approved"},
            status=status,
            detail="Verification code sent." if status in {"pending", "approved"} else "Unable to send verification code.",
        )

    def check_code(self, phone_number: str, code: str) -> PhoneVerificationResult:
        payload = self._post("VerificationCheck", {"To": phone_number, "Code": code})
        status = str(payload.get("status") or "pending")
        approved = status == "approved"
        return PhoneVerificationResult(
            ok=approved,
            status=status,
            detail="Mobile number verified." if approved else "The verification code is incorrect or expired.",
        )


phone_verification_service = PhoneVerificationService()
