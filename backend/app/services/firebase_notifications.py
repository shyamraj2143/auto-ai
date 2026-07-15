from __future__ import annotations

import base64
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from jose import jwt

from app.core.config import settings

logger = logging.getLogger(__name__)


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
        if not settings.FCM_ENABLED:
            return False
        try:
            return bool(self._service_account())
        except (ValueError, TypeError, KeyError):
            return False

    def send_update_notification(
        self,
        token: str,
        *,
        version_code: int,
        version_name: str,
        changelog: str | None = None,
    ) -> FcmSendResult:
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
        return self._send(message)

    def send_call_data(self, token: str, data: dict[str, str], ttl_seconds: int) -> FcmSendResult:
        message = {
            "message": {
                "token": token,
                "data": data,
                "android": {
                    "priority": "HIGH",
                    "ttl": f"{max(1, ttl_seconds)}s",
                    "direct_boot_ok": False,
                },
            }
        }
        return self._send(message)

    def send_chat_data(self, token: str, data: dict[str, str], title: str, body: str) -> FcmSendResult:
        message = {
            "message": {
                "token": token,
                "notification": {"title": title[:120], "body": body[:180]},
                "data": data,
                "android": {
                    "priority": "HIGH",
                    "notification": {
                        "channel_id": "auto_ai_messages",
                        "default_sound": True,
                        "notification_priority": "PRIORITY_HIGH",
                    },
                },
            }
        }
        return self._send(message)

    def send_device_command(self, token: str, *, command_type: str, user_id: str, title: str, body: str) -> FcmSendResult:
        message = {
            "message": {
                "token": token,
                "notification": {"title": title[:120], "body": body[:180]},
                "data": {
                    "type": command_type,
                    "userId": user_id,
                    "user_id": user_id,
                    "title": title,
                    "body": body,
                },
                "android": {
                    "priority": "HIGH",
                    "notification": {
                        "channel_id": "auto_ai_device_control",
                        "default_sound": False,
                        "notification_priority": "PRIORITY_HIGH",
                    },
                },
            }
        }
        return self._send(message)

    def _send(self, message: dict[str, Any]) -> FcmSendResult:
        try:
            service_account = self._service_account()
        except (ValueError, TypeError, KeyError):
            logger.warning("fcm_send_skipped reason=invalid_service_account")
            return FcmSendResult(ok=False, detail="Firebase service account configuration is invalid.")
        if not service_account:
            logger.info("fcm_send_skipped reason=unconfigured")
            return FcmSendResult(ok=False, detail="Firebase service account is not configured.")
        project_id = settings.FIREBASE_PROJECT_ID or str(service_account.get("project_id") or "")
        if not project_id:
            logger.warning("fcm_send_skipped reason=missing_project_id")
            return FcmSendResult(ok=False, detail="Firebase project id is missing.")
        data = message.get("message", {}).get("data", {})
        message_type = data.get("type") if isinstance(data, dict) else None
        call_id = data.get("call_id") if isinstance(data, dict) else None
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
            logger.warning("fcm_send_failed project_id=%s type=%s call_id=%s detail=%s", project_id, message_type, call_id, str(exc)[:160])
            return FcmSendResult(ok=False, detail=str(exc))
        if 200 <= response.status_code < 300:
            logger.info("fcm_send_ok project_id=%s type=%s call_id=%s", project_id, message_type, call_id)
            return FcmSendResult(ok=True)
        error_text = response.text
        inactive = response.status_code == 404 or "UNREGISTERED" in error_text or "not a valid FCM" in error_text
        logger.warning("fcm_send_http_error project_id=%s type=%s call_id=%s status=%d inactive=%s detail=%s", project_id, message_type, call_id, response.status_code, inactive, error_text[:160])
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
        client_email = (settings.FIREBASE_CLIENT_EMAIL or "").strip()
        private_key = settings.FIREBASE_PRIVATE_KEY.get_secret_value() if settings.FIREBASE_PRIVATE_KEY else ""
        project_id = (settings.FIREBASE_PROJECT_ID or "").strip()
        if client_email and private_key and project_id:
            return {
                "project_id": project_id,
                "client_email": client_email,
                "private_key": private_key.replace("\\n", "\n"),
                "token_uri": DEFAULT_TOKEN_URI,
            }
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
