#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import sys
import time
import uuid
from pathlib import Path
from urllib import error, request
from urllib.parse import urlencode


DEFAULT_API_URL = "https://auto-ai-app-download.up.railway.app/api/v1"


def api_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/{path.lstrip('/')}"


def read_http_error(exc: error.HTTPError) -> str:
    try:
        return exc.read().decode("utf-8", errors="replace")
    except Exception:
        return exc.reason


def post_json(url: str, payload: dict[str, object], token: str | None = None, timeout: float = 60) -> dict[str, object]:
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
    with request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str, timeout: float = 10) -> dict[str, object]:
    req = request.Request(url, headers={"Accept": "application/json"}, method="GET")
    with request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_backend(base_url: str, attempts: int = 20, delay_seconds: int = 10) -> None:
    """Wait for Railway deployment and database readiness before publishing release metadata."""
    health_url = api_url(base_url, "/health")
    ready_url = api_url(base_url, "/ready")
    last_error = "backend did not become ready"
    for attempt in range(1, attempts + 1):
        try:
            health = get_json(health_url, timeout=10)
            if str(health.get("status", "")).lower() != "ok":
                last_error = f"health status={health.get('status')}"
            else:
                ready = get_json(ready_url, timeout=10)
                if str(ready.get("status", "")).lower() == "ready":
                    print(f"Backend is healthy and database is ready (attempt {attempt}).")
                    return
                last_error = f"readiness status={ready.get('status')}"
        except error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {read_http_error(exc)}"
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        print(f"Backend readiness attempt {attempt}/{attempts} failed: {last_error}", file=sys.stderr)
        if attempt < attempts:
            time.sleep(delay_seconds)
    raise RuntimeError(f"Production backend did not become ready: {last_error}")


def login_with_retry(base_url: str, email: str, password: str, attempts: int = 6, delay_seconds: int = 10) -> str:
    last_error = "login failed"
    for attempt in range(1, attempts + 1):
        try:
            login = post_json(
                api_url(base_url, "/auth/login"),
                {"email": email, "password": password},
                timeout=30,
            )
            token = str(login.get("access_token") or "")
            if token:
                return token
            last_error = "login response did not contain access_token"
        except error.HTTPError as exc:
            last_error = f"HTTP {exc.code}: {read_http_error(exc)}"
        except Exception as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        print(f"Admin login attempt {attempt}/{attempts} failed: {last_error}", file=sys.stderr)
        if attempt < attempts:
            time.sleep(delay_seconds)
    raise RuntimeError(f"Production admin login failed after retries: {last_error}")


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


def publish_metadata(
    base_url: str,
    token: str,
    apk_path: Path,
    *,
    version_name: str,
    version_code: int,
    min_android_version: str,
    release_notes: str,
    changelog: str,
    force_update: bool,
) -> dict[str, object]:
    checksum = sha256_file(apk_path)
    query = urlencode({"version": version_name})
    return post_json(
        api_url(base_url, "/admin/apk/version"),
        {
            "version_name": version_name,
            "version_code": version_code,
            "apk_url": f"/api/download/apk/github/latest?{query}",
            "file_name": apk_path.name,
            "file_size": apk_path.stat().st_size,
            "sha256": checksum,
            "is_active": True,
            "min_android_version": min_android_version,
            "release_notes": [release_notes],
            "changelog": changelog,
            "force_update": force_update,
        },
        token,
        timeout=60,
    )


def env_or_arg(value: str | None, env_name: str, fallback: str | None = None) -> str | None:
    return value or os.getenv(env_name) or fallback


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="Register the GitHub-hosted APK without uploading the binary to the backend.",
    )
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
        wait_for_backend(api_base)
        token = login_with_retry(api_base, admin_email, admin_password)
        release_notes = args.release_notes.strip() or args.changelog.strip() or f"Version {args.version_name}"
        changelog = args.changelog.strip() or release_notes
        if args.metadata_only:
            release = publish_metadata(
                api_base,
                token,
                apk_path,
                version_name=args.version_name,
                version_code=args.version_code,
                min_android_version=args.min_android_version,
                release_notes=release_notes,
                changelog=changelog,
                force_update=args.force_update,
            )
        else:
            release = upload_apk(
                api_base,
                token,
                apk_path,
                {
                    "version_name": args.version_name,
                    "version_code": str(args.version_code),
                    "min_android_version": args.min_android_version,
                    "release_notes": json.dumps([release_notes]),
                    "changelog": changelog,
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
