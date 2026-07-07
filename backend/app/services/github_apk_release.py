import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx

from app.core.config import settings
from app.schemas.download import ApkReleaseRead
from app.services.apk_service import ApkService


GITHUB_REPO = os.getenv("AUTO_AI_GITHUB_APK_REPO", "robinmaker123-ai/auto-ai").strip()
GITHUB_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
GITHUB_DOWNLOAD_URL = "/api/download/apk/github/latest"
GITHUB_CACHE_TTL_SECONDS = 60


@dataclass(frozen=True)
class GitHubApkRelease:
    read: ApkReleaseRead
    asset_url: str


class GitHubApkReleaseService:
    def __init__(self) -> None:
        self._cached_release: GitHubApkRelease | None = None
        self._cached_at: datetime | None = None

    def latest_release(self) -> GitHubApkRelease | None:
        now = datetime.now(UTC)
        if (
            self._cached_release
            and self._cached_at
            and now - self._cached_at < timedelta(seconds=GITHUB_CACHE_TTL_SECONDS)
        ):
            return self._cached_release

        try:
            release = self._fetch_latest_release()
        except httpx.HTTPError:
            release = None

        self._cached_release = release
        self._cached_at = now
        return release

    def _fetch_latest_release(self) -> GitHubApkRelease | None:
        with httpx.Client(timeout=8.0, follow_redirects=True) as client:
            response = client.get(GITHUB_API_URL, headers={"Accept": "application/vnd.github+json"})
            if response.status_code == 404:
                return None
            response.raise_for_status()
            payload = response.json()

        assets = payload.get("assets") if isinstance(payload, dict) else None
        if not isinstance(assets, list):
            return None
        asset = next(
            (
                item
                for item in assets
                if isinstance(item, dict)
                and str(item.get("name", "")).lower().endswith(".apk")
                and str(item.get("browser_download_url", "")).startswith("https://")
            ),
            None,
        )
        if not asset:
            return None

        body = str(payload.get("body") or "")
        tag = str(payload.get("tag_name") or "")
        name = str(payload.get("name") or "")
        asset_name = str(asset.get("name") or settings.APK_FILENAME)
        version_code = self._parse_int(body, r"Version-Code:\s*(\d+)") or self._parse_int(tag, r"(\d+)") or self._parse_int(asset_name, r"(\d+)")
        if not version_code:
            return None
        version_name = self._parse_text(body, r"Version-Name:\s*([^\s]+)") or f"1.0.{version_code}"
        sha256 = self._parse_text(body, r"SHA256:\s*([A-Fa-f0-9]{64})") or ""
        released_at = self._parse_datetime(str(payload.get("published_at") or payload.get("created_at") or ""))
        download_url = f"{GITHUB_DOWNLOAD_URL}?version={version_name}"
        release_notes = self._release_notes(body)
        changelog = self._parse_text(body, r"Changelog:\s*(.+)") or name or f"Version {version_name}"

        read = ApkReleaseRead(
            id=f"github-{version_code}",
            version_code=version_code,
            version_name=version_name,
            apk_url=download_url,
            file_name=asset_name,
            file_size=int(asset.get("size") or 0),
            changelog=changelog,
            force_update=os.getenv("AUTO_AI_GITHUB_APK_FORCE_UPDATE", "").lower() == "true",
            is_active=True,
            download_count=0,
            created_at=ApkService.response_datetime(released_at),
            updated_at=ApkService.response_datetime(released_at),
            released_at=ApkService.response_datetime(released_at),
            release_date=ApkService.response_datetime(released_at),
            version=version_name,
            filename=asset_name,
            sha256=sha256,
            min_android_version=settings.APK_MIN_ANDROID_VERSION,
            release_notes=release_notes,
            download_url=download_url,
        )
        return GitHubApkRelease(read=read, asset_url=str(asset["browser_download_url"]))

    @staticmethod
    def _parse_int(value: str, pattern: str) -> int | None:
        match = re.search(pattern, value)
        return int(match.group(1)) if match else None

    @staticmethod
    def _parse_text(value: str, pattern: str) -> str | None:
        match = re.search(pattern, value, flags=re.IGNORECASE)
        return match.group(1).strip() if match else None

    @staticmethod
    def _parse_datetime(value: str) -> datetime:
        if not value:
            return datetime.now(UTC)
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(UTC)

    @staticmethod
    def _release_notes(body: str) -> list[str]:
        notes: list[str] = []
        for line in body.splitlines():
            line = line.strip("- ").strip()
            if not line or re.match(r"^(Version-Code|Version-Name|SHA256|Changelog):", line, flags=re.IGNORECASE):
                continue
            notes.append(line)
        return notes[:20] or ["Auto update from GitHub push"]


github_apk_release_service = GitHubApkReleaseService()
