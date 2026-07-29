import pytest
from pydantic import ValidationError

from app.core.config import Settings


def production_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "ENVIRONMENT": "production",
        "FRONTEND_URL": "https://example.com",
        "BACKEND_URL": "https://api.example.com",
        "DB_BACKEND": "sqlite",
        "SQLITE_PATH": "/data/auto_ai.db",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://example.up.railway.app", "https://example.up.railway.app"),
        ("example.up.railway.app", "https://example.up.railway.app"),
        ('"  example.up.railway.app  "', "https://example.up.railway.app"),
    ],
)
def test_backend_url_normalization(value: str, expected: str) -> None:
    assert production_settings(BACKEND_URL=value).backend_url == expected


def test_backend_url_falls_back_to_railway_public_domain() -> None:
    configured = production_settings(
        BACKEND_URL=None,
        RAILWAY_PUBLIC_DOMAIN="example.up.railway.app",
    )

    assert configured.backend_url == "https://example.up.railway.app"


@pytest.mark.parametrize("value", ["not a valid url", "ftp://example.com"])
def test_backend_url_rejects_malformed_or_unsupported_values(value: str) -> None:
    with pytest.raises(ValidationError, match="BACKEND_URL"):
        production_settings(BACKEND_URL=value)


def test_production_backend_url_rejects_localhost() -> None:
    with pytest.raises(ValidationError, match="cannot use localhost"):
        production_settings(BACKEND_URL="http://localhost:8000")


def test_development_backend_url_preserves_localhost() -> None:
    configured = Settings(
        _env_file=None,
        ENVIRONMENT="development",
        BACKEND_URL="http://localhost:8000/",
    )

    assert configured.backend_url == "http://localhost:8000"


def test_production_sqlite_uploads_share_the_persistent_volume() -> None:
    configured = production_settings()

    assert configured.UPLOAD_DIR == "/data/uploads"


def test_explicit_production_upload_directory_is_preserved() -> None:
    configured = production_settings(UPLOAD_DIR="/mnt/media")

    assert configured.UPLOAD_DIR == "/mnt/media"


def test_apk_upload_limit_is_separate_from_document_limit() -> None:
    configured = production_settings()

    assert configured.MAX_APK_UPLOAD_MB == 100
    assert configured.MAX_UPLOAD_MB == 20
