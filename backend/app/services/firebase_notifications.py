from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from firebase_admin import credentials, get_app, initialize_app, messaging

from app.core.config import settings
from app.services.notification_destination import with_notification_destination

logger = logging.getLogger(__name__)


@dataclass
class FcmSendResult:
    ok: bool
    inactive: bool = False
    detail: str = ""
    failure_code: str | None = None


class FirebaseNotificationService:
    def __init__(self) -> None:
        self._app = None

    @property
    def configured(self) -> bool:
        if not settings.FCM_ENABLED:
            return False
        try:
            return bool(self._service_account())
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return False

    def send_update_notification(
        self,
        target: str,
        *,
        version_code: int,
        version_name: str,
        changelog: str | None = None,
        release_id: str = "",
        target_kind: str = "token",
    ) -> FcmSendResult:
        message = {
            "message": {
                **self._target(target, target_kind),
                "notification": {
                    "title": f"Auto-AI {version_name} is available",
                    "body": (changelog or "A new Auto-AI Android update is ready.")[:180],
                },
                "data": with_notification_destination({
                    "type": "apk_update",
                    "event_id": f"apk_update:{release_id or version_code}",
                    "version_code": str(version_code),
                    "version_name": version_name,
                    "release_id": release_id,
                    "force_update": "true",
                }),
                "android": {
                    "priority": "high",
                    "channel_id": "auto_ai_updates",
                    "sound": "default",
                },
            }
        }
        return self._send(message)

    @staticmethod
    def _target(target: str, target_kind: str) -> dict[str, str]:
        return {"fid": target} if target_kind == "fid" else {"token": target}

    def send_call_data(
        self,
        target: str,
        data: dict[str, str],
        ttl_seconds: int,
        *,
        target_kind: str = "token",
    ) -> FcmSendResult:
        return self._send({"message": {
            **self._target(target, target_kind),
            "data": data,
            "android": {
                "priority": "high",
                "ttl": max(1, ttl_seconds),
                "direct_boot_ok": False,
                "restricted_package_name": "com.autoai.app",
                "collapse_key": f"call_{data.get('call_id', 'unknown')}",
            },
        }})

    def send_call_system_fallback(
        self,
        target: str,
        data: dict[str, str],
        title: str,
        body: str,
        ttl_seconds: int,
        notification_tag: str,
        *,
        target_kind: str = "token",
    ) -> FcmSendResult:
        fallback_body = body if body.endswith("tap to answer") else f"{body} — tap to answer"
        return self._send({"message": {
            **self._target(target, target_kind),
            "notification": {"title": title[:120], "body": fallback_body[:180]},
            "data": data,
            "android": {
                "priority": "high",
                "ttl": max(1, ttl_seconds),
                "direct_boot_ok": False,
                "notification": {
                    "channel_id": "auto_ai_incoming_calls_v6",
                    "default_sound": True,
                    "visibility": "PUBLIC",
                    "tag": notification_tag,
                    "click_action": "com.autoai.app.INCOMING_CALL_FALLBACK",
                },
            },
        }})

    def send_chat_data(
        self,
        target: str,
        data: dict[str, str],
        title: str,
        body: str,
        *,
        target_kind: str = "token",
    ) -> FcmSendResult:
        return self._send({"message": {
            **self._target(target, target_kind),
            "notification": {"title": title[:120], "body": body[:180]},
            "data": data,
            "android": {
                "priority": "high",
                "notification": {
                    "channel_id": "auto_ai_messages",
                    "default_sound": True,
                },
            },
        }})

    def send_alarm_data(
        self,
        target: str,
        data: dict[str, str],
        *,
        ttl_seconds: int = 2_419_200,
        target_kind: str = "token",
    ) -> FcmSendResult:
        alarm_id = data.get("alarm_id", "unknown")
        return self._send({"message": {
            **self._target(target, target_kind),
            "data": data,
            "android": {
                "priority": "high",
                "ttl": max(60, min(ttl_seconds, 2_419_200)),
                "direct_boot_ok": False,
                "restricted_package_name": "com.autoai.app",
                "collapse_key": f"alarm_{alarm_id}",
            },
        }})

    def send_relationship_followup(
        self,
        target: str,
        data: dict[str, str],
        title: str,
        body: str,
        *,
        target_kind: str = "token",
    ) -> FcmSendResult:
        contact_id = data.get("contact_id", "unknown")
        return self._send({"message": {
            **self._target(target, target_kind),
            "notification": {"title": title[:120], "body": body[:180]},
            "data": data,
            "android": {
                "priority": "high",
                "ttl": 86400,
                "collapse_key": f"relationship_{contact_id}",
                "notification": {
                    "channel_id": "auto_ai_relationship_followups",
                    "default_sound": True,
                    "visibility": "PRIVATE",
                    "tag": f"relationship_{contact_id}",
                },
            },
        }})

    def _get_app(self, service_account: dict[str, Any]):
        if self._app is not None:
            return self._app
        try:
            self._app = get_app()
        except ValueError:
            self._app = initialize_app(credentials.Certificate(service_account))
        return self._app

    @staticmethod
    def _build_message(message: dict[str, Any]) -> messaging.Message:
        payload = dict(message.get("message") or {})
        kwargs: dict[str, Any] = {}
        if payload.get("fid"):
            kwargs["fid"] = str(payload["fid"])
        elif payload.get("token"):
            kwargs["token"] = str(payload["token"])
        elif payload.get("topic"):
            kwargs["topic"] = str(payload["topic"])
        elif payload.get("condition"):
            kwargs["condition"] = str(payload["condition"])
        else:
            raise ValueError("FCM message has no destination")

        raw_data = payload.get("data") or {}
        kwargs["data"] = {str(key): str(value) for key, value in raw_data.items()}

        notification = payload.get("notification")
        if isinstance(notification, dict):
            kwargs["notification"] = messaging.Notification(
                title=str(notification.get("title") or "")[:120],
                body=str(notification.get("body") or "")[:180],
                image=str(notification.get("image") or "") or None,
            )

        android = dict(payload.get("android") or {})
        android_kwargs: dict[str, Any] = {}
        priority = str(android.get("priority") or "normal").lower()
        if priority in {"high", "normal"}:
            android_kwargs["priority"] = priority
        ttl = android.get("ttl")
        if isinstance(ttl, int):
            from datetime import timedelta
            android_kwargs["ttl"] = timedelta(seconds=max(1, ttl))
        elif isinstance(ttl, str) and ttl.endswith("s"):
            from datetime import timedelta
            try:
                android_kwargs["ttl"] = timedelta(seconds=max(1, int(ttl[:-1])))
            except ValueError:
                pass
        for field in ("collapse_key", "restricted_package_name", "direct_boot_ok"):
            if android.get(field) is not None:
                android_kwargs[field] = android[field]

        android_notification = dict(android.get("notification") or {})
        if android.get("channel_id"):
            android_notification.setdefault("channel_id", android["channel_id"])
        if android.get("sound"):
            android_notification.setdefault("sound", android["sound"])
        allowed_notification_fields = (
            "icon", "color", "sound", "tag", "click_action", "channel_id",
            "ticker", "sticky", "local_only", "visibility", "default_sound",
        )
        notification_kwargs = {key: android_notification[key] for key in allowed_notification_fields if key in android_notification}
        if notification_kwargs:
            if "default_sound" in notification_kwargs:
                notification_kwargs["default_sound"] = bool(notification_kwargs["default_sound"])
            android_kwargs["notification"] = messaging.AndroidNotification(**notification_kwargs)
        if android_kwargs:
            kwargs["android"] = messaging.AndroidConfig(**android_kwargs)
        return messaging.Message(**kwargs)

    def _send(self, message: dict[str, Any]) -> FcmSendResult:
        try:
            service_account = self._service_account()
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            logger.warning("fcm_send_skipped reason=invalid_service_account error=%s", type(exc).__name__)
            return FcmSendResult(ok=False, detail="Firebase service account configuration is invalid.", failure_code="FCM_CONFIG_INVALID")
        if not service_account:
            logger.info("fcm_send_skipped reason=unconfigured")
            return FcmSendResult(ok=False, detail="Firebase service account is not configured.", failure_code="FCM_CONFIG_MISSING")
        try:
            app = self._get_app(service_account)
            response = messaging.send(self._build_message(message), app=app)
            logger.info("fcm_send_ok response=%s", response)
            return FcmSendResult(ok=True, detail=str(response))
        except Exception as exc:
            text = str(exc)
            lower = text.lower()
            inactive = any(marker in lower for marker in (
                "unregistered", "not registered", "registration token is not a valid",
                "requested entity was not found", "requested entity was not found",
            ))
            if inactive:
                code = "FCM_TOKEN_UNREGISTERED"
            elif "sender_id_mismatch" in lower:
                code = "FCM_TOKEN_PROJECT_MISMATCH"
            elif "credential" in lower or "permission" in lower or "unauthenticated" in lower:
                code = "FCM_AUTH_FAILED"
            else:
                code = "FCM_SEND_FAILED"
            logger.warning("fcm_send_failed inactive=%s error_type=%s detail=%s", inactive, type(exc).__name__, text[:300])
            return FcmSendResult(ok=False, inactive=inactive, detail=text[:500], failure_code=code)

    def _service_account(self) -> dict[str, Any] | None:
        client_email = (settings.FIREBASE_CLIENT_EMAIL or "").strip()
        private_key = settings.FIREBASE_PRIVATE_KEY.get_secret_value() if settings.FIREBASE_PRIVATE_KEY else ""
        project_id = (settings.FIREBASE_PROJECT_ID or "").strip()
        if client_email and private_key and project_id:
            return {
                "project_id": project_id,
                "client_email": client_email,
                "private_key": private_key.replace("\\n", "\n"),
                "token_uri": "https://oauth2.googleapis.com/token",
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
