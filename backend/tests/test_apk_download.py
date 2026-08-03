from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.api.routes import download as download_routes
from app.core.config import settings
from app.db.base import Base
from app.services.apk_service import apk_service


def test_download_streams_github_apk_when_railway_file_is_missing(monkeypatch) -> None:
    db_release = SimpleNamespace(id="release-1", version_name="1.2.3")
    github_release = SimpleNamespace(
        asset_url="https://github.com/shyamraj2143/auto-ai/releases/download/android-123/auto-ai.apk",
        read=SimpleNamespace(
            version_name="1.2.3",
            version_code=123,
            file_name="auto-ai.apk",
            file_size=55_374_476,
            sha256="a" * 64,
        ),
    )
    db = Mock()
    request = Mock(headers={}, client=None)
    monkeypatch.setattr(download_routes.apk_service, "find_release", lambda *_args: db_release)
    monkeypatch.setattr(
        download_routes.apk_service,
        "validate_release_file",
        lambda *_args: (_ for _ in ()).throw(HTTPException(status_code=404, detail="missing")),
    )
    monkeypatch.setattr(download_routes.apk_service, "record_download", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(download_routes.github_apk_release_service, "latest_release", lambda: github_release)

    response = download_routes.download_apk(request, version="1.2.3", db=db)

    assert isinstance(response, StreamingResponse)
    assert response.status_code == 200
    assert response.media_type == "application/vnd.android.package-archive"
    assert response.headers["x-auto-ai-apk-version-code"] == "123"
    assert response.headers["content-length"] == str(github_release.read.file_size)
    assert "location" not in response.headers
    db.commit.assert_called_once()


def test_github_repository_is_not_legacy_repository() -> None:
    from app.services.github_apk_release import GITHUB_RELEASES_REQUIRE_UPDATE, GITHUB_REPO

    assert GITHUB_REPO != "robinmaker123-ai/auto-ai"
    assert GITHUB_RELEASES_REQUIRE_UPDATE is True


def test_metadata_release_keeps_checksum_and_uses_missing_storage_path(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(settings, "APK_STORAGE_DIR", str(tmp_path))
    checksum = "a" * 64

    with Session(engine) as db:
        release = apk_service.upsert_version(
            db,
            release_id=None,
            version_code=101461,
            version_name="1.0.101461",
            apk_url="/api/download/apk/github/latest?version=1.0.101461",
            file_name="auto-ai.apk",
            file_size=55_374_476,
            sha256=checksum,
            changelog="GitHub release",
            force_update=False,
            is_active=True,
            released_at=None,
            min_android_version="Android 7.0",
            release_notes=["GitHub release"],
        )

        assert release.sha256 == checksum
        assert release.file_path == str(tmp_path / "auto-ai.apk")
        assert not (tmp_path / "auto-ai.apk").exists()
        assert apk_service.release_read(release).download_url.endswith("version=1.0.101461")


@pytest.mark.asyncio
async def test_apk_upload_uses_dedicated_size_limit(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    monkeypatch.setattr(settings, "APK_STORAGE_DIR", str(tmp_path))
    monkeypatch.setattr(settings, "MAX_APK_UPLOAD_MB", 1)
    monkeypatch.setattr(settings, "MAX_UPLOAD_MB", 50)
    upload = UploadFile(filename="auto-ai.apk", file=BytesIO(b"x" * (1024 * 1024 + 1)))

    with Session(engine) as db, pytest.raises(HTTPException) as error:
        await apk_service.save_upload(
            db,
            upload,
            version_name="1.0.999",
            version_code=999,
            min_android_version="Android 7.0",
            release_notes="test",
            changelog="test",
            force_update=False,
        )

    assert error.value.status_code == 413
    assert error.value.detail == "APK upload exceeds 1 MB."
    assert list(tmp_path.iterdir()) == []


def test_github_apk_asset_url_is_repository_scoped() -> None:
    from app.services.github_apk_release import GitHubApkReleaseService

    assert GitHubApkReleaseService._trusted_asset_url(
        "https://github.com/shyamraj2143/auto-ai/releases/download/android-123/auto-ai.apk"
    )
    assert not GitHubApkReleaseService._trusted_asset_url(
        "https://evil.example/shyamraj2143/auto-ai/releases/download/android-123/auto-ai.apk"
    )
    assert not GitHubApkReleaseService._trusted_asset_url(
        "https://github.com/other/repo/releases/download/android-123/auto-ai.apk"
    )


def test_github_proxy_rejects_incomplete_metadata() -> None:
    release = SimpleNamespace(read=SimpleNamespace(file_size=0, sha256=""), asset_url="https://github.com/shyamraj2143/auto-ai/releases/download/v1/auto-ai.apk")
    with pytest.raises(HTTPException) as error:
        download_routes.stream_github_apk(release)
    assert error.value.status_code == 503
