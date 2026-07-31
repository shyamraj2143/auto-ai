from io import BytesIO

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.core.config import settings
from app.db.base import Base
from app.models.library_asset import LibraryAsset
from app.models.user import User
from app.services.document_service import document_service
from app.services.library_asset_service import classify_and_validate, upsert_library_asset


def test_auto_archive_deduplicates_same_attachment_for_one_user(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    stored = []
    monkeypatch.setattr(
        "app.services.library_asset_service.library_storage.put",
        lambda key, data, mime: stored.append((key, data, mime)),
    )

    with Session(engine) as db:
        user = User(
            id="auto-library-user",
            email="auto-library@example.test",
            name="Auto Library",
            username="auto-library",
            hashed_password="x",
        )
        db.add(user)
        db.commit()

        first = upsert_library_asset(
            db,
            user_id=user.id,
            filename="selfie.png",
            declared_mime="image/png",
            data=b"\x89PNG\r\n\x1a\ncontent",
            source="chat_attachment",
        )
        db.commit()
        second = upsert_library_asset(
            db,
            user_id=user.id,
            filename="selfie-copy.png",
            declared_mime="image/png",
            data=b"\x89PNG\r\n\x1a\ncontent",
            source="chat_attachment",
        )
        db.commit()

        assert first.id == second.id
        assert db.scalar(select(func.count()).select_from(LibraryAsset)) == 1
        assert len(stored) == 1
        assert first.source == "chat_attachment"


def test_code_attachment_is_classified_as_code():
    name, mime, file_type = classify_and_validate(
        "storefront.tsx",
        "text/plain",
        b"export default function Storefront() { return <main />; }",
    )
    assert name == "storefront.tsx"
    assert mime == "text/plain"
    assert file_type == "code"


@pytest.mark.asyncio
async def test_document_service_accepts_common_code_files(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))
    upload = UploadFile(
        filename="app.py",
        file=BytesIO(b"def hello():\n    return 'AutoAI'\n"),
        headers={"content-type": "text/x-python"},
    )

    stored_path, extraction = await document_service.save_and_extract(upload, "code-user")

    assert stored_path.endswith(".py")
    assert "def hello" in extraction.text
    assert extraction.metadata["file_kind"] == "code"
    assert extraction.metadata["parser"] == "source-code"
