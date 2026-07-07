#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib import error, request


DEFAULT_API_URL = "https://auto-ai-production-c510.up.railway.app/api/v1"


def api_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def read_http_error(exc: error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return exc.reason


def post_notification(base_url: str, secret: str, payload: dict[str, object]) -> dict[str, object]:
    req = request.Request(
        api_url(base_url, "/notifications/apk-update"),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "X-Auto-AI-Notify-Secret": secret,
        },
        method="POST",
    )
    with request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Notify installed Auto-AI Android apps about a new APK release.")
    parser.add_argument("--api-url", default=os.getenv("AUTO_AI_API_BASE_URL", DEFAULT_API_URL))
    parser.add_argument("--secret", default=os.getenv("AUTO_AI_UPDATE_NOTIFY_SECRET", ""))
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--changelog", default="")
    args = parser.parse_args()

    if not args.secret:
        print("AUTO_AI_UPDATE_NOTIFY_SECRET is missing; skipping app update push notification.")
        return 0

    try:
        result = post_notification(
            args.api_url,
            args.secret,
            {
                "version_code": args.version_code,
                "version_name": args.version_name,
                "changelog": args.changelog,
            },
        )
    except error.HTTPError as exc:
        print(f"Notification failed ({exc.code}): {read_http_error(exc)}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Notification failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
