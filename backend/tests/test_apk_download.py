from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.api.routes import download as download_routes


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
