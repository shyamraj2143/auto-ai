from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    if read(path) != content:
        target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}")
    write(path, content.replace(old, new, 1))


def patch_requirements() -> None:
    path = "backend/requirements.txt"
    content = read(path)
    if not any(line.strip().lower().startswith("firebase-admin") for line in content.splitlines()):
        write(path, content.rstrip() + "\nfirebase-admin>=7.5.0\n")


def patch_groq_vision() -> None:
    path = "backend/app/services/groq_service.py"
    content = read(path)
    import_line = "from app.services.nvidia_vision_service import nvidia_vision_service\n"
    if import_line not in content:
        replace_once(path, "from app.core.config import settings\n", "from app.core.config import settings\n" + import_line)
        content = read(path)

    pattern = re.compile(
        r"    def analyze_image\(self, image_bytes: bytes, filename: str, prompt: str\) -> str:\n.*?(?=\n    def transcribe_audio\()",
        re.S,
    )
    replacement = '''    def analyze_image(self, image_bytes: bytes, filename: str, prompt: str) -> str:\n        \"\"\"Analyze an uploaded image with Groq Vision, then NVIDIA Vision if Groq fails.\"\"\"\n        if not image_bytes:\n            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=\"Image is empty.\")\n\n        suffix = Path(filename).suffix.lower().replace(\".\", \"\") or \"png\"\n        mime = \"jpeg\" if suffix == \"jpg\" else suffix\n        encoded = base64.b64encode(image_bytes).decode(\"ascii\")\n        messages = [{\n            \"role\": \"user\",\n            \"content\": [\n                {\"type\": \"text\", \"text\": prompt},\n                {\"type\": \"image_url\", \"image_url\": {\"url\": f\"data:image/{mime};base64,{encoded}\"}},\n            ],\n        }]\n        errors: list[str] = []\n\n        try:\n            content, _, _ = self._complete_groq(\n                messages,\n                model=settings.GROQ_VISION_MODEL,\n                max_tokens=settings.GROQ_MAX_TOKENS,\n                request_timeout=90,\n            )\n            if content.strip():\n                return content.strip()\n        except Exception as exc:\n            errors.append(f\"groq:{type(exc).__name__}\")\n\n        try:\n            content = nvidia_vision_service.analyze_image(\n                image_bytes,\n                filename,\n                prompt,\n                mime_type=f\"image/{mime}\",\n                max_tokens=settings.GROQ_MAX_TOKENS,\n                timeout=90,\n            )\n            if content.strip():\n                return content.strip()\n        except Exception as exc:\n            errors.append(f\"nvidia:{type(exc).__name__}\")\n\n        raise HTTPException(\n            status_code=status.HTTP_502_BAD_GATEWAY,\n            detail=\"Image analysis failed for both Groq Vision and NVIDIA Vision. \" + \", \".join(errors),\n        )\n'''
    updated, count = pattern.subn(replacement, content, count=1)
    if count != 1:
        raise RuntimeError("GroqService.analyze_image was not found exactly once")
    write(path, updated)


def patch_ai_route() -> None:
    path = "backend/app/api/routes/ai.py"
    content = read(path)
    content = content.replace(
        '''requested_models=[\n                        *payload.groq_models,\n                        *payload.bedrock_models,\n                        *payload.openai_models,\n                        *payload.gemini_models,\n                    ],''',
        '''requested_models=[\n                        *payload.groq_models,\n                        *payload.nvidia_models,\n                        *payload.openai_models,\n                    ],''',
        1,
    )
    content = content.replace(
        'provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI", "gemini": "Gemini"}.get(provider, provider)',
        'provider_name = {"groq": "Groq", "nvidia": "NVIDIA", "openai": "OpenAI"}.get(provider, provider)',
    )
    content = content.replace(
        'provider_name = {"groq": "Groq", "bedrock": "AWS Bedrock", "openai": "OpenAI", "gemini": "Gemini"}[provider]',
        'provider_name = {"groq": "Groq", "nvidia": "NVIDIA", "openai": "OpenAI"}[provider]',
    )
    write(path, content)


def patch_orchestrator_and_activity() -> None:
    path = "backend/app/services/orchestration/orchestrator.py"
    content = read(path)
    content = content.replace(
        '"contributed_to_final_answer": True})',
        '"contributed_to_final_answer": True, "response_preview": (result.content or "")[:1600]})',
    )
    content = content.replace(
        '"contributed": result.contributed} for result in results]',
        '"contributed": result.contributed, "response_preview": (result.content or "")[:1600]} for result in results]',
    )
    write(path, content)

    path = "frontend/src/components/chat/LiveModelActivity.tsx"
    content = read(path)
    old = '''              {task.contributed_to_final_answer && <span className="model-contributed-badge">Used in final answer</span>}\n              {task.failure_reason && <span className="model-activity-fallback">{task.failure_reason}</span>}'''
    new = '''              {task.contributed_to_final_answer && <span className="model-contributed-badge">Used in final answer</span>}\n              {task.failure_reason && <span className="model-activity-fallback">{task.failure_reason}</span>}\n              {(task as OrchestrationActivityEvent & { response_preview?: string }).response_preview && task.status === "completed" && (\n                <div className="model-response-preview">\n                  <span>Model response</span>\n                  <p>{(task as OrchestrationActivityEvent & { response_preview?: string }).response_preview}</p>\n                </div>\n              )}'''
    if old in content and "model-response-preview" not in content:
        content = content.replace(old, new, 1)
    write(path, content)

    css_path = "frontend/src/components/chat/liveModelActivity.css"
    css = read(css_path)
    if ".model-response-preview" not in css:
        css += '''\n.model-response-preview {\n  margin-top: 10px;\n  padding: 9px 10px;\n  border: 1px solid rgba(121, 183, 255, .14);\n  border-radius: 10px;\n  background: rgba(4, 13, 31, .38);\n}\n.model-response-preview > span {\n  display: block;\n  margin-bottom: 5px;\n  color: #8fa8c8;\n  font-size: 10px;\n  font-weight: 700;\n  text-transform: uppercase;\n  letter-spacing: .08em;\n}\n.model-response-preview p {\n  margin: 0;\n  color: #dce9ff;\n  font-size: 12px;\n  line-height: 1.55;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n'''
    write(css_path, css)


def patch_firebase_service() -> None:
    path = "backend/app/services/firebase_notifications.py"
    content = read(path)
    if "from firebase_admin import credentials, get_app, initialize_app, messaging" not in content:
        replace_once(
            path,
            "import httpx\n",
            "import httpx\nfrom firebase_admin import credentials, get_app, initialize_app, messaging\n",
        )
        content = read(path)

    helper = '''    def _firebase_admin_app(self, service_account: dict[str, Any]):\n        try:\n            return get_app()\n        except ValueError:\n            return initialize_app(credentials.Certificate(service_account))\n\n    @staticmethod\n    def _admin_message(message: dict[str, Any]) -> messaging.Message:\n        payload = message.get("message", {})\n        kwargs: dict[str, Any] = {}\n        data = payload.get("data") or {}\n        kwargs["data"] = {str(key): str(value) for key, value in data.items()}\n        if payload.get("fid"):\n            kwargs["fid"] = str(payload["fid"])\n        elif payload.get("token"):\n            kwargs["token"] = str(payload["token"])\n        elif payload.get("topic"):\n            kwargs["topic"] = str(payload["topic"])\n        elif payload.get("condition"):\n            kwargs["condition"] = str(payload["condition"])\n        else:\n            raise ValueError("FCM message has no supported target")\n\n        notification = payload.get("notification")\n        if isinstance(notification, dict):\n            kwargs["notification"] = messaging.Notification(\n                title=str(notification.get("title") or "")[:120],\n                body=str(notification.get("body") or "")[:180],\n                image=str(notification.get("image") or "") or None,\n            )\n\n        android = payload.get("android") or {}\n        android_kwargs: dict[str, Any] = {}\n        priority = str(android.get("priority") or "normal").lower()\n        if priority in {"high", "normal"}:\n            android_kwargs["priority"] = priority\n        ttl = android.get("ttl")\n        if isinstance(ttl, str) and ttl.endswith("s"):\n            try:\n                from datetime import timedelta\n                android_kwargs["ttl"] = timedelta(seconds=max(1, int(ttl[:-1])))\n            except ValueError:\n                pass\n        for field in ("collapse_key", "restricted_package_name", "direct_boot_ok"):\n            if field in android and android[field] is not None:\n                android_kwargs[field] = android[field]\n        n = android.get("notification") or {}\n        if isinstance(n, dict):\n            allowed = ("icon", "color", "sound", "tag", "click_action", "channel_id", "ticker", "image", "sticky", "local_only")\n            n_kwargs = {field: n[field] for field in allowed if n.get(field) is not None}\n            if "default_sound" in n:\n                n_kwargs["default_sound"] = bool(n["default_sound"])\n            if n_kwargs:\n                android_kwargs["notification"] = messaging.AndroidNotification(**n_kwargs)\n        if android_kwargs:\n            kwargs["android"] = messaging.AndroidConfig(**android_kwargs)\n        return messaging.Message(**kwargs)\n\n'''
    if "def _firebase_admin_app" not in content:
        replace_once(path, "    def _send(self, message: dict[str, Any]) -> FcmSendResult:\n", helper + "    def _send(self, message: dict[str, Any]) -> FcmSendResult:\n")
        content = read(path)

    pattern = re.compile(r"    def _send\(self, message: dict\[str, Any\]\) -> FcmSendResult:\n.*?(?=\n    def _access_token_for\()", re.S)
    replacement = '''    def _send(self, message: dict[str, Any]) -> FcmSendResult:\n        try:\n            service_account = self._service_account()\n        except (ValueError, TypeError, KeyError, json.JSONDecodeError):\n            logger.warning("fcm_send_skipped reason=invalid_service_account")\n            return FcmSendResult(ok=False, detail="Firebase service account configuration is invalid.")\n        if not service_account:\n            logger.info("fcm_send_skipped reason=unconfigured")\n            return FcmSendResult(ok=False, detail="Firebase service account is not configured.")\n        try:\n            app = self._firebase_admin_app(service_account)\n            response = messaging.send(self._admin_message(message), app=app)\n            logger.info("fcm_send_ok response=%s", response)\n            return FcmSendResult(ok=True)\n        except Exception as exc:\n            text = str(exc)\n            lower = text.lower()\n            inactive = any(marker in lower for marker in ("unregistered", "not registered", "registration token is not a valid", "requested entity was not found"))\n            code = "FCM_TOKEN_UNREGISTERED" if inactive else "FCM_SEND_FAILED"\n            logger.warning("fcm_send_failed inactive=%s error_type=%s detail=%s", inactive, type(exc).__name__, text[:300])\n            return FcmSendResult(ok=False, inactive=inactive, detail=text[:500], failure_code=code)\n'''
    updated, count = pattern.subn(replacement, content, count=1)
    if count != 1:
        raise RuntimeError("FirebaseNotificationService._send was not found exactly once")
    write(path, updated)


def patch_notification_route_and_tests() -> None:
    path = "backend/app/api/routes/notifications.py"
    content = read(path)
    content = content.replace(
        "from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status",
        "from fastapi import APIRouter, Depends, HTTPException, Request, status",
    )
    content = content.replace(
        '''def notify_apk_update(\n    payload: ApkUpdateNotificationRequest,\n    request: Request,\n    background_tasks: BackgroundTasks,\n    db: Session = Depends(get_db),\n) -> ApkUpdateNotificationResponse:''',
        '''def notify_apk_update(\n    payload: ApkUpdateNotificationRequest,\n    request: Request,\n    db: Session = Depends(get_db),\n) -> ApkUpdateNotificationResponse:''',
        1,
    )
    old = '''    background_tasks.add_task(\n        dispatch_apk_update_notifications,\n        payload.version_code,\n        payload.version_name,\n        payload.changelog,\n    )\n    logger.info(\n        "apk_update_notification_queued version_code=%d authorization=%s",\n        payload.version_code,\n        authorization_mode,\n    )\n    return ApkUpdateNotificationResponse(detail="Notification dispatch queued.")'''
    new = '''    sent, failed, inactive = dispatch_apk_update_notifications(\n        payload.version_code,\n        payload.version_name,\n        payload.changelog,\n    )\n    logger.info(\n        "apk_update_notification_dispatched version_code=%d authorization=%s sent=%d failed=%d inactive=%d",\n        payload.version_code,\n        authorization_mode,\n        sent,\n        failed,\n        inactive,\n    )\n    return ApkUpdateNotificationResponse(\n        sent=sent,\n        failed=failed,\n        inactive=inactive,\n        detail=f"Notification dispatch completed: sent={sent}, failed={failed}, inactive={inactive}.",\n    )'''
    if old not in content:
        raise RuntimeError("notification background dispatch block not found")
    content = content.replace(old, new, 1)
    old_end = '''    logger.info(\n        "apk_update_notification_dispatch version_code=%d sent=%d failed=%d inactive=%d",\n        version_code,\n        sent,\n        failed,\n        inactive,\n    )'''
    new_end = old_end + "\n    return sent, failed, inactive"
    if old_end not in content:
        raise RuntimeError("notification dispatch logger block not found")
    content = content.replace(old_end, new_end, 1)
    write(path, content)

    path = "backend/tests/test_update_notifications.py"
    tests = read(path)
    old_test = '''def test_apk_update_notification_is_queued_without_blocking_request(monkeypatch) -> None:\n    request = Mock(headers={"x-auto-ai-notify-secret": "test-secret"})\n    background_tasks = BackgroundTasks()\n    monkeypatch.setattr(notifications, "notify_secret_value", lambda: "test-secret")\n    monkeypatch.setattr(\n        type(notifications.firebase_notification_service),\n        "configured",\n        property(lambda _self: True),\n    )\n\n    response = notifications.notify_apk_update(\n        ApkUpdateNotificationRequest(\n            version_code=101471,\n            version_name="1.0.101471",\n            changelog="Call Hub fixes",\n        ),\n        request,\n        background_tasks,\n    )\n\n    assert response.detail == "Notification dispatch queued."\n    assert response.sent == 0\n    assert len(background_tasks.tasks) == 1\n'''
    new_test = '''def test_apk_update_notification_dispatches_synchronously(monkeypatch) -> None:\n    request = Mock(headers={"x-auto-ai-notify-secret": "test-secret"})\n    monkeypatch.setattr(notifications, "notify_secret_value", lambda: "test-secret")\n    monkeypatch.setattr(\n        type(notifications.firebase_notification_service),\n        "configured",\n        property(lambda _self: True),\n    )\n    monkeypatch.setattr(notifications, "dispatch_apk_update_notifications", lambda *args: (2, 0, 0))\n\n    response = notifications.notify_apk_update(\n        ApkUpdateNotificationRequest(\n            version_code=101471,\n            version_name="1.0.101471",\n            changelog="Call Hub fixes",\n        ),\n        request,\n        object(),\n    )\n\n    assert response.sent == 2\n    assert response.failed == 0\n    assert response.inactive == 0\n    assert "completed" in response.detail.lower()\n'''
    if old_test in tests:
        tests = tests.replace(old_test, new_test, 1)
    write(path, tests)


def patch_notify_script() -> None:
    path = "scripts/notify_android_update.py"
    content = read(path)
    old = '''    detail = str(result.get("detail") or "")\n    if "queued" not in detail.casefold():\n        print(\n            "Notification API returned an unexpected response: "\n            f"{json.dumps(result, sort_keys=True)}",\n            file=sys.stderr,\n        )\n        return 1\n'''
    new = '''    sent = int(result.get("sent") or 0)\n    if sent < 1:\n        print(\n            "Update notification was not delivered to any active Android device: "\n            f"{json.dumps(result, sort_keys=True)}",\n            file=sys.stderr,\n        )\n        return 1\n'''
    if old in content:
        content = content.replace(old, new, 1)
    write(path, content)


def main() -> None:\n    patch_requirements()\n    patch_groq_vision()\n    patch_ai_route()\n    patch_orchestrator_and_activity()\n    patch_firebase_service()\n    patch_notification_route_and_tests()\n    patch_notify_script()\n\n\nif __name__ == "__main__":\n    main()\n