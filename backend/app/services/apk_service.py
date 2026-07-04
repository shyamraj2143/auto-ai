import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

from fastapi import HTTPException, Request, UploadFile, status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.apk import ApkDownload, ApkRelease
from app.models.user import User
from app.schemas.download import ApkReleaseRead


class ApkService:
    @staticmethod
    def storage_dir() -> Path:
        path = Path(settings.APK_STORAGE_DIR).resolve()
        path.mkdir(parents=True, exist_ok=True)
        return path

    @classmethod
    def default_apk_path(cls) -> Path:
        return cls.storage_dir() / settings.APK_FILENAME

    @staticmethod
    def sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _download_url(version_name: str | None = None) -> str:
        return f"/api/download/apk?version={version_name}" if version_name else "/api/download/apk"

    @classmethod
    def release_read(cls, release: ApkRelease) -> ApkReleaseRead:
        download_url = release.apk_url or cls._download_url(release.version_name)
        return ApkReleaseRead(
            id=release.id,
            version_name=release.version_name,
            apk_url=download_url,
            release_date=release.release_date,
            force_update=release.force_update,
            download_count=release.download_count,
            version=release.version_name,
            version_code=release.version_code,
            filename=release.filename,
            file_size=release.file_size,
            sha256=release.sha256,
            min_android_version=release.min_android_version,
            release_notes=[str(item) for item in (release.release_notes or [])],
            changelog=release.changelog or "",
            is_active=release.is_active,
            created_at=release.created_at,
            download_url=download_url,
        )

    @staticmethod
    def next_version(current: str | None) -> str:
        if not current:
            return settings.APK_DEFAULT_VERSION
        match = re.match(r"^(\d+)\.(\d+)\.(\d+)", current)
        if not match:
            return settings.APK_DEFAULT_VERSION
        major, minor, patch = (int(part) for part in match.groups())
        return f"{major}.{minor}.{patch + 1}"

    @staticmethod
    def parse_release_notes(value: str | None) -> list[str]:
        if not value:
            return []
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item).strip() for item in parsed if str(item).strip()]
        except json.JSONDecodeError:
            pass
        return [line.strip("- ").strip() for line in value.splitlines() if line.strip("- ").strip()]

    def latest_release(self, db: Session) -> ApkRelease | None:
        return db.scalar(
            select(ApkRelease)
            .where(ApkRelease.is_active.is_(True))
            .order_by(ApkRelease.version_code.desc(), ApkRelease.created_at.desc())
        )

    def highest_release(self, db: Session) -> ApkRelease | None:
        return db.scalar(select(ApkRelease).order_by(ApkRelease.version_code.desc(), ApkRelease.created_at.desc()))

    def find_release(self, db: Session, version: str | None = None) -> ApkRelease | None:
        if version:
            return db.scalar(select(ApkRelease).where(ApkRelease.version_name == version))
        return self.latest_release(db)

    @staticmethod
    def versioned_filename(version_name: str, version_code: int) -> str:
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", version_name).strip(".-") or "release"
        return f"auto-ai-{version_code}-{safe_name}.apk"

    def sync_filesystem_release(self, db: Session) -> None:
        path = self.default_apk_path()
        if not path.exists():
            return
        releases = db.scalars(select(ApkRelease)).all()
        if any(release.filename != settings.APK_FILENAME for release in releases):
            return
        checksum = self.sha256_file(path)
        version_name = settings.APK_DEFAULT_VERSION
        version_code = settings.APK_DEFAULT_VERSION_CODE
        release = db.scalar(select(ApkRelease).where(ApkRelease.version_name == version_name))
        if release and release.is_active and release.sha256 == checksum and Path(release.file_path).exists():
            return

        db.execute(update(ApkRelease).values(is_active=False))
        if release:
            previous_downloads = release.download_count or 0
            release.filename = settings.APK_FILENAME
            release.file_path = str(path)
            release.file_size = path.stat().st_size
            release.sha256 = checksum
            release.min_android_version = settings.APK_MIN_ANDROID_VERSION
            release.release_notes = release.release_notes or ["Production Android APK"]
            release.changelog = release.changelog or f"Version {version_name}"
            release.apk_url = self._download_url(version_name)
            release.version_code = version_code
            release.version_name = version_name
            release.download_count = previous_downloads
            release.is_active = True
        else:
            db.add(
                ApkRelease(
                    version_code=version_code,
                    version_name=version_name,
                    apk_url=self._download_url(version_name),
                    filename=settings.APK_FILENAME,
                    file_path=str(path),
                    file_size=path.stat().st_size,
                    sha256=checksum,
                    min_android_version=settings.APK_MIN_ANDROID_VERSION,
                    release_notes=["Production Android APK"],
                    changelog=f"Version {version_name}",
                    is_active=True,
                )
            )
        db.commit()

    def validate_release_file(self, release: ApkRelease) -> Path:
        path = Path(release.file_path).resolve()
        storage_dir = self.storage_dir()
        if storage_dir not in path.parents and path != storage_dir / release.filename:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid APK storage path.")
        if not path.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK file not found on server.")
        checksum = self.sha256_file(path)
        if checksum != release.sha256:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="APK integrity check failed.")
        return path

    def record_download(
        self,
        db: Session,
        release: ApkRelease | None,
        request: Request,
        user: User | None = None,
        *,
        status_value: str = "completed",
    ) -> None:
        forwarded_for = request.headers.get("x-forwarded-for", "")
        ip = forwarded_for.split(",", 1)[0].strip() or (request.client.host if request.client else "unknown")
        db.add(
            ApkDownload(
                release_id=release.id if release else None,
                user_id=user.id if user else None,
                ip_address=ip[:80],
                user_agent=request.headers.get("user-agent", "")[:2000],
                status=status_value,
            )
        )
        if release and status_value == "completed":
            release.download_count = (release.download_count or 0) + 1

    async def save_upload(
        self,
        db: Session,
        file: UploadFile,
        *,
        version_name: str | None,
        version_code: int | None,
        min_android_version: str | None,
        release_notes: str | None,
        changelog: str | None,
        force_update: bool,
    ) -> ApkRelease:
        if not (file.filename or "").lower().endswith(".apk"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only .apk files are accepted.")

        highest = self.highest_release(db)
        next_version = version_name or self.next_version(highest.version_name if highest else None)
        next_version_code = version_code or ((highest.version_code + 1) if highest else 1)
        if db.scalar(select(ApkRelease).where(ApkRelease.version_name == next_version)):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="APK version name already exists.")
        if db.scalar(select(ApkRelease).where(ApkRelease.version_code == next_version_code)):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="APK version code already exists.")

        filename = self.versioned_filename(next_version, next_version_code)
        path = self.storage_dir() / filename
        max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
        bytes_written = 0

        with path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                bytes_written += len(chunk)
                if bytes_written > max_bytes:
                    output.close()
                    path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"APK upload exceeds {settings.MAX_UPLOAD_MB} MB.",
                    )
                output.write(chunk)

        if not zipfile.is_zipfile(path):
            path.unlink(missing_ok=True)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is not a valid APK archive.")

        checksum = self.sha256_file(path)
        latest_path = self.default_apk_path()
        if path != latest_path:
            shutil.copyfile(path, latest_path)
        db.execute(update(ApkRelease).values(is_active=False))
        release = ApkRelease(
            version_code=next_version_code,
            version_name=next_version,
            apk_url=self._download_url(next_version),
            filename=filename,
            file_path=str(path),
            file_size=path.stat().st_size,
            sha256=checksum,
            min_android_version=min_android_version or settings.APK_MIN_ANDROID_VERSION,
            release_notes=self.parse_release_notes(release_notes),
            changelog=changelog or f"Version {next_version}",
            force_update=force_update,
            is_active=True,
        )
        db.add(release)
        db.commit()
        db.refresh(release)
        return release

    def download_counts(self, db: Session) -> dict[str, int]:
        rows = db.execute(
            select(ApkRelease.version_name, ApkRelease.download_count)
            .order_by(ApkRelease.version_code.desc())
        ).all()
        return {version: int(count) for version, count in rows}

    def update_release(
        self,
        db: Session,
        release_id: str,
        *,
        changelog: str | None = None,
        force_update: bool | None = None,
        release_notes: list[str] | None = None,
        is_active: bool | None = None,
    ) -> ApkRelease:
        release = db.get(ApkRelease, release_id)
        if not release:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK version not found.")
        if changelog is not None:
            release.changelog = changelog
        if force_update is not None:
            release.force_update = force_update
        if release_notes is not None:
            release.release_notes = [item.strip() for item in release_notes if item.strip()]
        if is_active is not None:
            if is_active:
                db.execute(update(ApkRelease).where(ApkRelease.id != release.id).values(is_active=False))
            release.is_active = is_active
        db.commit()
        db.refresh(release)
        return release


apk_service = ApkService()
