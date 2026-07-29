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
    assert "location" not in response.headers
    db.commit.assert_called_once()


def test_github_repository_is_not_legacy_repository() -> None:
    from app.services.github_apk_release import GITHUB_REPO

    assert GITHUB_REPO != "robinmaker123-ai/auto-ai"


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
