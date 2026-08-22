from __future__ import annotations

from typing import Any

from app.services.firebase_notifications import FcmSendResult, firebase_notification_service


def send_chat_data_only(
    target: str,
    data: dict[str, str],
    *,
    target_kind: str = "token",
    ttl_seconds: int = 86_400,
) -> FcmSendResult:
    """Send chat pushes as high-priority data-only FCM.

    Data-only delivery ensures the native Android FirebaseMessagingService receives
    the event in background/terminated states and can create the correct channel,
    deep-link and inline actions itself.
    """
    message: dict[str, Any] = {
        "message": {
            **firebase_notification_service._target(target, target_kind),
            "data": {str(key): str(value) for key, value in data.items()},
            "android": {
                "priority": "high",
                "ttl": max(60, min(int(ttl_seconds), 2_419_200)),
                "direct_boot_ok": False,
                "restricted_package_name": "com.autoai.app",
                "collapse_key": f"chat_{data.get('thread_id', 'unknown')}",
            },
        }
    }
    return firebase_notification_service._send(message)
