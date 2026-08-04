#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import error, request


DEFAULT_API_URL = "https://auto-ai-production-a6ef.up.railway.app/api/v1"


def api_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def read_http_error(exc: error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return str(exc.reason)


def post_json(
    url: str,
    payload: dict[str, object],
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 120,
) -> dict[str, object]:
    request_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
    }
    if headers:
        request_headers.update(headers)
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=request_headers,
        method="POST",
    )
    with request.urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def admin_access_token(base_url: str, email: str, password: str) -> str:
    result = post_json(
        api_url(base_url, "/auth/login"),
        {"email": email, "password": password},
        timeout=60,
    )
    token = str(result.get("access_token") or "").strip()
    if not token:
        raise RuntimeError("Administrator login did not return an access token.")
    user = result.get("user")
    if isinstance(user, dict):
        role = str(user.get("role") or "").lower()
        is_admin = bool(user.get("is_admin"))
        if not is_admin or role not in {"admin", "super_admin", "administrator"}:
            raise RuntimeError("Configured release account is not an administrator.")
    return token


def post_notification(
    base_url: str,
    payload: dict[str, object],
    *,
    secret: str = "",
    access_token: str = "",
) -> dict[str, object]:
    headers: dict[str, str] = {}
    if secret:
        headers["X-Auto-AI-Notify-Secret"] = secret
    elif access_token:
        headers["Authorization"] = f"Bearer {access_token}"
    else:
        raise RuntimeError("No notification authorization method is available.")
    return post_json(
        api_url(base_url, "/notifications/apk-update"),
        payload,
        headers=headers,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Notify installed Auto-AI Android apps about a new APK release."
    )
    parser.add_argument(
        "--api-url",
        default=os.getenv("AUTO_AI_API_BASE_URL", DEFAULT_API_URL),
    )
    parser.add_argument(
        "--secret",
        default=os.getenv("AUTO_AI_UPDATE_NOTIFY_SECRET", ""),
    )
    parser.add_argument(
        "--admin-email",
        default=os.getenv("AUTO_AI_ADMIN_EMAIL", ""),
    )
    parser.add_argument(
        "--admin-password",
        default=os.getenv("AUTO_AI_ADMIN_PASSWORD", ""),
    )
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--changelog", default="")
    args = parser.parse_args()

    try:
        access_token = ""
        authorization_mode = "notification_secret"
        if not args.secret:
            if not args.admin_email or not args.admin_password:
                print(
                    "Provide AUTO_AI_UPDATE_NOTIFY_SECRET or administrator credentials.",
                    file=sys.stderr,
                )
                return 1
            access_token = admin_access_token(
                args.api_url,
                args.admin_email,
                args.admin_password,
            )
            authorization_mode = "administrator"

        result = post_notification(
            args.api_url,
            {
                "version_code": args.version_code,
                "version_name": args.version_name,
                "changelog": args.changelog,
            },
            secret=args.secret,
            access_token=access_token,
        )
    except error.HTTPError as exc:
        print(
            f"Notification failed ({exc.code}): {read_http_error(exc)}",
            file=sys.stderr,
        )
        return 1
    except Exception as exc:
        print(f"Notification failed: {exc}", file=sys.stderr)
        return 1

    if bool(result.get("skipped")):
        print(
            f"Notification dispatch was skipped: {result.get('detail', 'unknown reason')}",
            file=sys.stderr,
        )
        return 1
    detail = str(result.get("detail") or "")
    if "queued" not in detail.casefold():
        print(
            "Notification API returned an unexpected response: "
            f"{json.dumps(result, sort_keys=True)}",
            file=sys.stderr,
        )
        return 1

    print(
        json.dumps(
            {**result, "authorization_mode": authorization_mode},
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
