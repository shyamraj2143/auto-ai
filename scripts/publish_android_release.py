#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import uuid
from pathlib import Path
from urllib import error, request


DEFAULT_API_URL = "https://auto-ai-production-c510.up.railway.app/api/v1"


def api_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def read_http_error(exc: error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return exc.reason


def post_json(url: str, payload: dict[str, object], token: str | None = None) -> dict[str, object]:
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with request.urlopen(req, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def multipart_body(fields: dict[str, str], file_field: str, file_path: Path) -> tuple[bytes, str]:
    boundary = f"----AutoAiRelease{uuid.uuid4().hex}"
    lines: list[bytes] = []
    for name, value in fields.items():
        lines.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )

    filename = file_path.name
    content_type = mimetypes.guess_type(filename)[0] or "application/vnd.android.package-archive"
    lines.extend(
        [
            f"--{boundary}\r\n".encode("utf-8"),
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode("utf-8"),
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
            file_path.read_bytes(),
            b"\r\n",
            f"--{boundary}--\r\n".encode("utf-8"),
        ]
    )
    return b"".join(lines), boundary


def upload_apk(base_url: str, token: str, apk_path: Path, fields: dict[str, str]) -> dict[str, object]:
    body, boundary = multipart_body(fields, "file", apk_path)
    req = request.Request(
        api_url(base_url, "/download/apk/releases"),
        data=body,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )
    with request.urlopen(req, timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def env_or_arg(value: str | None, env_name: str, fallback: str | None = None) -> str | None:
    return value or os.getenv(env_name) or fallback


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish an Auto-AI Android APK release.")
    parser.add_argument("--api-url")
    parser.add_argument("--admin-email")
    parser.add_argument("--admin-password")
    parser.add_argument("--apk", required=True)
    parser.add_argument("--version-code", required=True, type=int)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--min-android-version", default="Android 7.0")
    parser.add_argument("--release-notes", default="")
    parser.add_argument("--changelog", default="")
    parser.add_argument("--force-update", action="store_true")
    args = parser.parse_args()

    api_base = env_or_arg(args.api_url, "AUTO_AI_API_BASE_URL", DEFAULT_API_URL)
    admin_email = env_or_arg(args.admin_email, "AUTO_AI_ADMIN_EMAIL")
    admin_password = env_or_arg(args.admin_password, "AUTO_AI_ADMIN_PASSWORD")
    apk_path = Path(args.apk)

    if not admin_email or not admin_password:
        print("AUTO_AI_ADMIN_EMAIL and AUTO_AI_ADMIN_PASSWORD are required.", file=sys.stderr)
        return 2
    if not apk_path.is_file():
        print(f"APK not found: {apk_path}", file=sys.stderr)
        return 2

    try:
        login = post_json(
            api_url(api_base, "/auth/login"),
            {"email": admin_email, "password": admin_password},
        )
        token = str(login["access_token"])
        release_notes = args.release_notes.strip() or args.changelog.strip() or f"Version {args.version_name}"
        release = upload_apk(
            api_base,
            token,
            apk_path,
            {
                "version_name": args.version_name,
                "version_code": str(args.version_code),
                "min_android_version": args.min_android_version,
                "release_notes": json.dumps([release_notes]),
                "changelog": args.changelog.strip() or release_notes,
                "force_update": "true" if args.force_update else "false",
            },
        )
    except error.HTTPError as exc:
        print(f"Release publish failed ({exc.code}): {read_http_error(exc)}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Release publish failed: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(release, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
