import hashlib
import json
import re
import shutil
import zipfile
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, Request, UploadFile, status
from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.apk import ApkDownload, ApkRelease
from app.models.user import User
from app.schemas.download import ApkReleaseRead


def kolkata_timezone():
    try:
        return ZoneInfo("Asia/Kolkata")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=5, minutes=30), "Asia/Kolkata")


class ApkService:
    response_tz = kolkata_timezone()

    @staticmethod
    def _db_datetime(value: datetime | None = None) -> datetime:
        timestamp = value or datetime.utcnow()
        if timestamp.tzinfo:
            return timestamp.astimezone(UTC).replace(tzinfo=None)
        return timestamp

    @classmethod
    def response_datetime(cls, value: datetime | None) -> datetime:
        timestamp = value or datetime.utcnow()
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=UTC)
        return timestamp.astimezone(cls.response_tz)

    @staticmethod
    def file_name_from_url(apk_url: str | None) -> str:
        if not apk_url:
            return settings.APK_FILENAME
        candidate = Path(urlsplit(apk_url).path).name
        return candidate or settings.APK_FILENAME

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
        created_at = cls.response_datetime(release.created_at)
        updated_at = cls.response_datetime(release.updated_at or release.created_at)
        released_at = cls.response_datetime(release.released_at or release.created_at)
        return ApkReleaseRead(
            id=release.id,
            version_code=release.version_code,
            version_name=release.version_name,
            apk_url=download_url,
            file_name=release.file_name,
            file_size=release.file_size,
            changelog=release.changelog or "",
            force_update=release.force_update,
            is_active=release.is_active,
            download_count=release.download_count,
            created_at=created_at,
            updated_at=updated_at,
            released_at=released_at,
            release_date=released_at,
            version=release.version_name,
            filename=release.file_name,
            sha256=release.sha256,
            min_android_version=release.min_android_version,
            release_notes=[str(item) for item in (release.release_notes or [])],
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
            .order_by(ApkRelease.version_code.desc(), ApkRelease.released_at.desc())
        )

    def highest_release(self, db: Session) -> ApkRelease | None:
        return db.scalar(select(ApkRelease).order_by(ApkRelease.version_code.desc(), ApkRelease.released_at.desc()))

    def find_release(self, db: Session, version: str | None = None) -> ApkRelease | None:
        if version:
            return db.scalar(select(ApkRelease).where(ApkRelease.version_name == version))
        return self.latest_release(db)

    def find_release_for_count(
        self,
        db: Session,
        *,
        release_id: str | None = None,
        version_name: str | None = None,
        version_code: int | None = None,
    ) -> ApkRelease | None:
        if release_id:
            return db.get(ApkRelease, release_id)
        if version_name:
            return db.scalar(select(ApkRelease).where(ApkRelease.version_name == version_name))
        if version_code:
            return db.scalar(select(ApkRelease).where(ApkRelease.version_code == version_code))
        return self.latest_release(db)

    @staticmethod
    def versioned_filename(version_name: str, version_code: int) -> str:
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", version_name).strip(".-") or "release"
        return f"auto-ai-{version_code}-{safe_name}.apk"

    def sync_filesystem_release(self, db: Session) -> None:
        if db.scalar(select(ApkRelease.id).limit(1)):
            return
        path = self.default_apk_path()
        if not path.exists():
            return
        checksum = self.sha256_file(path)
        version_name = settings.APK_DEFAULT_VERSION
        version_code = settings.APK_DEFAULT_VERSION_CODE
        db.add(
            ApkRelease(
                version_code=version_code,
                version_name=version_name,
                apk_url=self._download_url(version_name),
                file_name=settings.APK_FILENAME,
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
        if storage_dir not in path.parents and path != storage_dir / release.file_name:
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
            db.execute(
                update(ApkRelease)
                .where(ApkRelease.id == release.id)
                .values(download_count=ApkRelease.download_count + 1, updated_at=ApkRelease.updated_at)
            )

    def increment_download_count(
        self,
        db: Session,
        release: ApkRelease,
        request: Request,
        user: User | None = None,
    ) -> ApkRelease:
        self.record_download(db, release, request, user)
        db.commit()
        db.refresh(release)
        return release

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
            file_name=filename,
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
        version_name: str | None = None,
        version_code: int | None = None,
        apk_url: str | None = None,
        file_name: str | None = None,
        file_size: int | None = None,
        changelog: str | None = None,
        force_update: bool | None = None,
        release_notes: list[str] | None = None,
        is_active: bool | None = None,
        released_at: datetime | None = None,
    ) -> ApkRelease:
        release = db.get(ApkRelease, release_id)
        if not release:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="APK version not found.")
        if version_name is not None and version_name != release.version_name:
            existing = db.scalar(select(ApkRelease).where(ApkRelease.version_name == version_name, ApkRelease.id != release.id))
            if existing:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="APK version name already exists.")
            if apk_url is None and release.apk_url.startswith("/api/download/apk"):
                release.apk_url = self._download_url(version_name)
            release.version_name = version_name
        if version_code is not None and version_code != release.version_code:
            existing = db.scalar(select(ApkRelease).where(ApkRelease.version_code == version_code, ApkRelease.id != release.id))
            if existing:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="APK version code already exists.")
            release.version_code = version_code
        if apk_url is not None:
            release.apk_url = apk_url.strip() or self._download_url(release.version_name)
        if file_name is not None:
            release.file_name = file_name.strip() or self.file_name_from_url(release.apk_url)
        if file_size is not None:
            release.file_size = file_size
        if changelog is not None:
            release.changelog = changelog
        if force_update is not None:
            release.force_update = force_update
        if release_notes is not None:
            release.release_notes = [item.strip() for item in release_notes if item.strip()]
        if released_at is not None:
            release.released_at = self._db_datetime(released_at)
        if is_active is not None:
            if is_active:
                db.execute(update(ApkRelease).where(ApkRelease.id != release.id).values(is_active=False))
            release.is_active = is_active
        release.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(release)
        return release

    def upsert_version(
        self,
        db: Session,
        *,
        release_id: str | None,
        version_code: int,
        version_name: str,
        apk_url: str,
        file_name: str | None,
        file_size: int,
        changelog: str,
        force_update: bool,
        is_active: bool,
        released_at: datetime | None,
        min_android_version: str,
        release_notes: list[str],
    ) -> ApkRelease:
        release = db.get(ApkRelease, release_id) if release_id else None
        if not release:
            release = db.scalar(
                select(ApkRelease).where(or_(ApkRelease.version_code == version_code, ApkRelease.version_name == version_name))
            )
        if release:
            release.min_android_version = min_android_version
            return self.update_release(
                db,
                release.id,
                version_name=version_name,
                version_code=version_code,
                apk_url=apk_url,
                file_name=file_name or self.file_name_from_url(apk_url),
                file_size=file_size,
                changelog=changelog,
                force_update=force_update,
                release_notes=release_notes,
                is_active=is_active,
                released_at=released_at or release.released_at,
            )

        if is_active:
            db.execute(update(ApkRelease).values(is_active=False))
        now = datetime.utcnow()
        release = ApkRelease(
            version_code=version_code,
            version_name=version_name,
            apk_url=apk_url,
            file_name=file_name or self.file_name_from_url(apk_url),
            file_path="",
            file_size=file_size,
            sha256="",
            min_android_version=min_android_version,
            release_notes=[item.strip() for item in release_notes if item.strip()],
            changelog=changelog,
            force_update=force_update,
            is_active=is_active,
            created_at=now,
            updated_at=now,
            released_at=self._db_datetime(released_at),
        )
        db.add(release)
        db.commit()
        db.refresh(release)
        return release


apk_service = ApkService()
