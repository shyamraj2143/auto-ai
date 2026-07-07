from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from jose import jwt

from app.core.config import settings


FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"


@dataclass
class FcmSendResult:
    ok: bool
    inactive: bool = False
    detail: str = ""


class FirebaseNotificationService:
    def __init__(self) -> None:
        self._access_token: str | None = None
        self._access_token_expires_at = 0

    @property
    def configured(self) -> bool:
        return bool(self._service_account())

    def send_update_notification(
        self,
        token: str,
        *,
        version_code: int,
        version_name: str,
        changelog: str | None = None,
    ) -> FcmSendResult:
        service_account = self._service_account()
        if not service_account:
            return FcmSendResult(ok=False, detail="Firebase service account is not configured.")
        project_id = settings.FIREBASE_PROJECT_ID or str(service_account.get("project_id") or "")
        if not project_id:
            return FcmSendResult(ok=False, detail="Firebase project id is missing.")

        title = "Auto-AI update available"
        body = f"Version {version_name} is ready to install."
        if changelog:
            body = f"{body} {changelog.strip()}"

        message = {
            "message": {
                "token": token,
                "notification": {
                    "title": title,
                    "body": body,
                },
                "data": {
                    "type": "apk_update",
                    "title": title,
                    "body": body,
                    "version_code": str(version_code),
                    "version_name": version_name,
                    "changelog": changelog or "",
                },
                "android": {
                    "priority": "HIGH",
                    "notification": {
                        "channel_id": "auto_ai_updates",
                        "default_sound": True,
                        "notification_priority": "PRIORITY_HIGH",
                    },
                },
            }
        }
        try:
            response = httpx.post(
                f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send",
                headers={
                    "Authorization": f"Bearer {self._access_token_for(service_account)}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=message,
                timeout=20.0,
            )
        except httpx.HTTPError as exc:
            return FcmSendResult(ok=False, detail=str(exc))
        if 200 <= response.status_code < 300:
            return FcmSendResult(ok=True)
        error_text = response.text
        inactive = response.status_code == 404 or "UNREGISTERED" in error_text or "not a valid FCM" in error_text
        return FcmSendResult(ok=False, inactive=inactive, detail=error_text[:500])

    def _access_token_for(self, service_account: dict[str, Any]) -> str:
        now = int(time.time())
        if self._access_token and now < self._access_token_expires_at - 60:
            return self._access_token
        token_uri = str(service_account.get("token_uri") or DEFAULT_TOKEN_URI)
        private_key = str(service_account["private_key"])
        client_email = str(service_account["client_email"])
        assertion = jwt.encode(
            {
                "iss": client_email,
                "scope": FCM_SCOPE,
                "aud": token_uri,
                "iat": now,
                "exp": now + 3600,
            },
            private_key,
            algorithm="RS256",
        )
        response = httpx.post(
            token_uri,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
            timeout=20.0,
        )
        response.raise_for_status()
        payload = response.json()
        self._access_token = str(payload["access_token"])
        self._access_token_expires_at = now + int(payload.get("expires_in", 3600))
        return self._access_token

    def _service_account(self) -> dict[str, Any] | None:
        raw_json = settings.FIREBASE_SERVICE_ACCOUNT_JSON.get_secret_value() if settings.FIREBASE_SERVICE_ACCOUNT_JSON else ""
        if raw_json.strip():
            return json.loads(raw_json)
        raw_base64 = settings.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64.get_secret_value() if settings.FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 else ""
        if raw_base64.strip():
            return json.loads(base64.b64decode(raw_base64).decode("utf-8"))
        if settings.FIREBASE_SERVICE_ACCOUNT_FILE:
            path = Path(settings.FIREBASE_SERVICE_ACCOUNT_FILE)
            if path.is_file():
                return json.loads(path.read_text(encoding="utf-8"))
        return None


firebase_notification_service = FirebaseNotificationService()
