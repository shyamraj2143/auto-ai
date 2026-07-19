from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from starlette.datastructures import Headers, UploadFile

from app.api.deps import get_current_cms_publisher
from app.api.routes.cms import (
    cms_ai_assist,
    preview_page,
    public_page,
    publish_page_endpoint,
    replace_media,
    restore_revision,
    save_page_draft,
    update_page,
    upload_media,
)
from app.core.config import settings
from app.db.base import Base
from app.models.cms import ContentPage, ContentRevision, GlobalContent, MediaAsset, UiTextEntry
from app.models.user import User
from app.main import app
from app.schemas.cms import CmsAiAssistRequest, CmsDraftUpdate, ContentBlockInput, ContentPageUpdate, PublishRequest, RestoreRevisionRequest
from app.services.cms_service import ensure_cms_defaults, publish_due, serialize_page
from app.services.groq_service import groq_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def user(db: Session, user_id: str, role: str) -> User:
    item = User(
        id=user_id, email=f"{user_id}@example.test", name=user_id.replace("-", " ").title(),
        username=user_id, hashed_password="unused", is_active=True, is_admin=role != "user", role=role,
    )
    db.add(item)
    db.commit()
    return item


def home(db: Session) -> ContentPage:
    return db.scalar(select(ContentPage).where(ContentPage.page_key == "home"))


def test_defaults_are_idempotent_and_drafts_are_not_public(db: Session) -> None:
    ensure_cms_defaults(db)
    counts = (
        db.scalar(select(func.count()).select_from(ContentPage)),
        db.scalar(select(func.count()).select_from(GlobalContent)),
        db.scalar(select(func.count()).select_from(UiTextEntry)),
    )
    ensure_cms_defaults(db)
    assert counts == (
        db.scalar(select(func.count()).select_from(ContentPage)),
        db.scalar(select(func.count()).select_from(GlobalContent)),
        db.scalar(select(func.count()).select_from(UiTextEntry)),
    )
    with pytest.raises(HTTPException) as exc:
        public_page("home", db)
    assert exc.value.status_code == 404


def test_draft_preview_publish_and_cached_public_fallback(db: Session) -> None:
    ensure_cms_defaults(db)
    admin = user(db, "cms-admin", "content_admin")
    page = home(db)
    original = page.hero_heading
    updated = update_page(
        page.id,
        ContentPageUpdate(
            expected_version=page.version,
            hero_heading="Published CMS Hero",
            element_overrides={"footer.description": {"text": "Editable footer", "hidden": False}},
        ),
        admin,
        db,
    )
    assert preview_page(page.id, admin, db)["preview"]["hero_heading"] == "Published CMS Hero"
    assert preview_page(page.id, admin, db)["preview"]["element_overrides"]["footer.description"]["text"] == "Editable footer"
    with pytest.raises(HTTPException):
        public_page("home", db)

    published = publish_page_endpoint(
        page.id,
        PublishRequest(expected_version=updated["version"], change_summary="Initial homepage publish"),
        admin,
        db,
    )
    assert public_page("home", db)["hero_heading"] == "Published CMS Hero"
    assert public_page("home", db)["element_overrides"]["footer.description"]["text"] == "Editable footer"
    draft = update_page(
        page.id,
        ContentPageUpdate(expected_version=published["version"], hero_heading="Unpublished Draft Hero"),
        admin,
        db,
    )
    assert preview_page(page.id, admin, db)["preview"]["hero_heading"] == "Unpublished Draft Hero"
    assert public_page("home", db)["hero_heading"] == "Published CMS Hero"
    assert original != "Unpublished Draft Hero"

    republished = publish_page_endpoint(
        page.id,
        PublishRequest(expected_version=draft["version"], change_summary="Publish updated homepage"),
        admin,
        db,
    )
    assert republished["status"] == "published"
    assert public_page("home", db)["hero_heading"] == "Unpublished Draft Hero"
    assert db.scalar(select(func.count()).select_from(ContentRevision).where(ContentRevision.content_id == page.id)) == 2


def test_atomic_cms_draft_document_saves_and_preserves_published_content(db: Session) -> None:
    ensure_cms_defaults(db)
    admin = user(db, "atomic-draft-admin", "content_admin")
    page = home(db)
    published = publish_page_endpoint(
        page.id,
        PublishRequest(expected_version=page.version, change_summary="Publish baseline"),
        admin,
        db,
    )
    baseline_heading = public_page("home", db)["hero_heading"]
    current = serialize_page(home(db))
    first_block = current["blocks"][0]
    payload = CmsDraftUpdate(
        schema_version=1,
        page_id=page.id,
        expected_version=published["version"],
        title=current["title"],
        slug=current["slug"],
        hero_heading="Atomic draft heading",
        hero_description=current["hero_description"],
        buttons=current["buttons"],
        element_overrides={"footer.description": {"text": "Saved footer", "hidden": False}},
        seo=current["seo"],
        blocks=[
            {
                "id": first_block["id"],
                "block_type": first_block["block_type"],
                "content": {**first_block["content"], "text": "Updated first block"},
                "is_visible": first_block["is_visible"],
            },
            {"block_type": "paragraph", "content": {"text": "New block"}, "is_visible": True},
        ],
    )

    saved = save_page_draft(page.id, payload, admin, db)

    assert saved["version"] == published["version"] + 1
    assert saved["hero_heading"] == "Atomic draft heading"
    assert saved["element_overrides"]["footer.description"]["text"] == "Saved footer"
    assert [block["content"]["text"] for block in saved["blocks"]] == ["Updated first block", "New block"]
    assert serialize_page(home(db))["blocks"] == saved["blocks"]
    assert public_page("home", db)["hero_heading"] == baseline_heading

    with pytest.raises(HTTPException) as conflict:
        save_page_draft(page.id, payload, admin, db)
    assert conflict.value.status_code == 409


def test_cms_draft_contract_reports_unknown_editor_field() -> None:
    with pytest.raises(ValidationError) as rejected:
        CmsDraftUpdate.model_validate({
            "schema_version": 1,
            "page_id": "page-id",
            "expected_version": 1,
            "title": "Home",
            "slug": "home",
            "hero_heading": "Heading",
            "hero_description": "Description",
            "buttons": [],
            "element_overrides": {},
            "seo": {},
            "blocks": [],
            "selected_block_id": "runtime-only",
        })

    error = rejected.value.errors()[0]
    assert error["loc"] == ("selected_block_id",)
    assert error["type"] == "extra_forbidden"


def test_content_editor_cannot_publish_and_unsafe_content_is_rejected(db: Session) -> None:
    editor = user(db, "cms-editor", "content_editor")
    with pytest.raises(HTTPException) as denied:
        get_current_cms_publisher(editor)
    assert denied.value.status_code == 403
    with pytest.raises(ValueError):
        ContentBlockInput(block_type="rich_text", content={"text": '<script>alert("x")</script>'})
    with pytest.raises(ValueError):
        ContentBlockInput(block_type="button", content={"url": "javascript:alert(1)"})
    with pytest.raises(ValueError):
        ContentPageUpdate(expected_version=1, element_overrides={"footer.brand": {"href": "javascript:alert(1)"}})


def test_unauthenticated_admin_cms_request_returns_401() -> None:
    response = TestClient(app).get("/api/v1/admin/cms/pages")
    assert response.status_code == 401


def test_cms_ai_assist_returns_suggestion_without_mutating_draft(db: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    ensure_cms_defaults(db)
    admin = user(db, "ai-content-admin", "content_admin")
    before = home(db).hero_heading
    monkeypatch.setattr(groq_service, "complete", lambda *args, **kwargs: ("A clearer hero heading", {"total_tokens": 8}, "test-model"))
    result = cms_ai_assist(CmsAiAssistRequest(action="rewrite", text=before), admin, db)
    assert result == {"suggestion": "A clearer hero heading", "model": "test-model"}
    assert home(db).hero_heading == before


def test_revision_restore_creates_new_history_entry(db: Session) -> None:
    ensure_cms_defaults(db)
    admin = user(db, "restore-admin", "super_admin")
    page = home(db)
    first = publish_page_endpoint(page.id, PublishRequest(expected_version=page.version, change_summary="Version one"), admin, db)
    second_draft = update_page(page.id, ContentPageUpdate(expected_version=first["version"], hero_heading="Version two"), admin, db)
    publish_page_endpoint(page.id, PublishRequest(expected_version=second_draft["version"], change_summary="Version two"), admin, db)
    revisions = db.scalars(select(ContentRevision).where(ContentRevision.content_id == page.id).order_by(ContentRevision.created_at)).all()
    before = len(revisions)
    current = home(db)
    restored = restore_revision(revisions[0].id, RestoreRevisionRequest(expected_version=current.version), admin, db)
    assert restored["status"] == "draft"
    assert restored["hero_heading"] == revisions[0].snapshot["hero_heading"]
    assert db.scalar(select(func.count()).select_from(ContentRevision).where(ContentRevision.content_id == page.id)) == before + 1


def test_scheduled_publish_uses_utc_and_invalidates_cache(db: Session) -> None:
    ensure_cms_defaults(db)
    admin = user(db, "schedule-admin", "content_admin")
    page = home(db)
    future = datetime.now(timezone.utc) + timedelta(hours=1)
    scheduled = publish_page_endpoint(page.id, PublishRequest(expected_version=page.version, change_summary="Schedule", scheduled_at=future), admin, db)
    assert scheduled["status"] == "scheduled"
    with pytest.raises(HTTPException):
        public_page("home", db)
    page = home(db)
    page.scheduled_at = datetime.utcnow() - timedelta(seconds=1)
    db.commit()
    assert publish_due(db) == 1
    assert public_page("home", db)["hero_heading"] == page.hero_heading


@pytest.mark.asyncio
async def test_media_upload_validates_signature_and_stores_path(db: Session, tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    admin = user(db, "media-admin", "content_admin")
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path))
    valid = UploadFile(filename="hero.png", file=BytesIO(b"\x89PNG\r\n\x1a\nvalid-image"), headers=Headers({"content-type": "image/png"}))
    result = await upload_media(valid, "Hero image", "Homepage", admin, db)
    assert result["url"].startswith("/uploads/cms/")
    assert db.scalar(select(func.count()).select_from(MediaAsset)) == 1
    assert "base64" not in result["url"]

    replacement = UploadFile(filename="replacement.png", file=BytesIO(b"\x89PNG\r\n\x1a\nreplacement"), headers=Headers({"content-type": "image/png"}))
    replaced = await replace_media(result["id"], replacement, admin, db)
    assert replaced["url"] == result["url"]

    invalid = UploadFile(filename="bad.png", file=BytesIO(b"not-an-image"), headers=Headers({"content-type": "image/png"}))
    with pytest.raises(HTTPException) as rejected:
        await upload_media(invalid, "", "", admin, db)
    assert rejected.value.status_code == 415
