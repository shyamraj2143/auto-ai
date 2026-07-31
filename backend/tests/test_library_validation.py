import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api.routes.library import asset_or_404, classify_and_validate
from app.db.base import Base
from app.models.library_asset import LibraryAsset
from app.models.user import User


@pytest.mark.parametrize(
    ("name", "mime", "data", "file_type"),
    [
        ("photo.png", "image/png", b"\x89PNG\r\n\x1a\ncontent", "image"),
        ("photo.jpg", "image/jpeg", b"\xff\xd8\xffcontent", "image"),
        ("report.pdf", "application/pdf", b"%PDF-1.7 content", "document"),
        ("notes.txt", "text/plain", b"hello", "document"),
        ("main.py", "text/plain", b"print('ok')", "code"),
    ],
)
def test_library_accepts_supported_content(name, mime, data, file_type):
    safe_name, canonical_mime, detected_type = classify_and_validate(name, mime, data)
    assert safe_name == name
    assert canonical_mime
    assert detected_type == file_type


@pytest.mark.parametrize(
    ("name", "mime", "data", "status_code"),
    [
        ("run.exe", "application/octet-stream", b"MZ", 415),
        ("fake.pdf", "application/pdf", b"not a pdf", 415),
        ("fake.png", "image/png", b"not png", 415),
        ("binary.txt", "text/plain", b"a\x00b", 415),
        ("empty.txt", "text/plain", b"", 400),
    ],
)
def test_library_rejects_dangerous_or_invalid_content(name, mime, data, status_code):
    with pytest.raises(HTTPException) as exc:
        classify_and_validate(name, mime, data)
    assert exc.value.status_code == status_code


def test_library_sanitizes_filename_paths():
    safe_name, _, _ = classify_and_validate("../../secret.txt", "text/plain", b"safe")
    assert safe_name == "secret.txt"


def test_library_asset_is_strictly_owner_scoped_and_deleted_assets_are_revoked():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        owner = User(id="library-owner", email="owner@example.test", name="Owner", username="owner", hashed_password="x")
        other = User(id="library-other", email="other@example.test", name="Other", username="other", hashed_password="x")
        asset = LibraryAsset(
            user_id=owner.id, original_name="notes.txt", display_name="notes.txt", mime_type="text/plain",
            file_type="document", file_size=5, storage_key="library-owner/asset.txt", checksum="a" * 64,
        )
        db.add_all([owner, other, asset])
        db.commit()
        assert asset_or_404(db, asset.id, owner.id).id == asset.id
        with pytest.raises(HTTPException) as foreign_access:
            asset_or_404(db, asset.id, other.id)
        assert foreign_access.value.status_code == 404
        asset.is_deleted = True
        db.commit()
        with pytest.raises(HTTPException) as deleted_access:
            asset_or_404(db, asset.id, owner.id)
        assert deleted_access.value.status_code == 404
