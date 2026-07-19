from datetime import datetime
import hashlib
from pathlib import Path
import uuid
from xml.sax.saxutils import escape

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import get_current_cms_editor, get_current_cms_publisher, get_current_cms_viewer
from app.core.config import settings
from app.db.session import get_db
from app.models.cms import Announcement, ContentAuditLog, ContentBlock, ContentPage, ContentRevision, FaqEntry, GlobalContent, MediaAsset, UiTextEntry
from app.models.user import User
from app.schemas.cms import (
    AnnouncementCreate, AnnouncementUpdate, BlockOrderUpdate, CmsAiAssistRequest, CmsDraftUpdate, ContentBlockInput, ContentBlockUpdate,
    ContentPageCreate, ContentPageUpdate, FaqCreate, FaqUpdate, MediaMetadataUpdate, PublishRequest,
    RestoreRevisionRequest, TextEntryUpdate, TextPublishRequest, reject_unsafe_markup,
)
from app.services.cms_service import (
    UI_TEXT_DEFAULTS, announcement_snapshot, audit, create_revision, ensure_cms_defaults, faq_snapshot,
    media_usage_count, page_snapshot, publish_due, publish_page, published_cache, require_version,
    revision_diff, serialize_announcement, serialize_faq, serialize_media, serialize_page, serialize_text_entry,
)
from app.services.admin_control import billable_usage, enforce_user_quota, record_usage_log, track_quota_usage
from app.services.groq_service import groq_service


router = APIRouter(tags=["content-manager"])
admin_router = APIRouter(prefix="/admin/cms")
public_router = APIRouter(prefix="/content/public")

ALLOWED_IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
ALLOWED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_MEDIA_BYTES = 8 * 1024 * 1024

CMS_AI_INSTRUCTIONS = {
    "rewrite": "Rewrite the copy clearly while preserving its meaning and approximate length.",
    "shorten": "Shorten the copy substantially while preserving the essential meaning.",
    "expand": "Expand the copy with useful detail without adding unverifiable claims.",
    "grammar": "Correct grammar, spelling, and punctuation without changing the voice.",
    "professional": "Make the copy concise, confident, and professional without hype.",
    "translate_hindi": "Translate the copy to natural Hindi.",
    "translate_english": "Translate the copy to natural English.",
    "cta": "Turn the copy into a short, action-oriented call to action.",
    "seo_heading": "Rewrite the copy as a concise, descriptive SEO-friendly heading without keyword stuffing.",
}


def paginated(items: list, total: int, page: int, page_size: int) -> dict:
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def get_page(db: Session, page_id: str) -> ContentPage:
    item = db.get(ContentPage, page_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Content page not found")
    return item


def get_block(db: Session, page_id: str, block_id: str) -> ContentBlock:
    item = db.scalar(select(ContentBlock).where(ContentBlock.id == block_id, ContentBlock.page_id == page_id))
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Content block not found")
    return item


def revision_payload(db: Session, revision: ContentRevision) -> dict:
    actor = db.get(User, revision.created_by) if revision.created_by else None
    previous = db.scalar(
        select(ContentRevision)
        .where(ContentRevision.content_type == revision.content_type, ContentRevision.content_id == revision.content_id, ContentRevision.created_at < revision.created_at)
        .order_by(ContentRevision.created_at.desc())
        .limit(1)
    )
    return {
        "id": revision.id, "content_type": revision.content_type, "content_id": revision.content_id,
        "action": revision.action, "status": revision.status, "version": revision.version,
        "change_summary": revision.change_summary, "snapshot": revision.snapshot,
        "changes": revision_diff(previous.snapshot if previous else None, revision.snapshot),
        "created_by": revision.created_by, "administrator": actor.name if actor else "System",
        "created_at": revision.created_at,
    }


@admin_router.get("/summary")
def cms_summary(_: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    ensure_cms_defaults(db)
    publish_due(db)
    return {
        "pages": db.scalar(select(func.count()).select_from(ContentPage)) or 0,
        "drafts": db.scalar(select(func.count()).select_from(ContentPage).where(ContentPage.status == "draft")) or 0,
        "published": db.scalar(select(func.count()).select_from(ContentPage).where(ContentPage.status == "published")) or 0,
        "scheduled": db.scalar(select(func.count()).select_from(ContentPage).where(ContentPage.status == "scheduled")) or 0,
        "media": db.scalar(select(func.count()).select_from(MediaAsset)) or 0,
        "faqs": db.scalar(select(func.count()).select_from(FaqEntry)) or 0,
    }


@admin_router.post("/ai-assist")
def cms_ai_assist(payload: CmsAiAssistRequest, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    instruction = CMS_AI_INSTRUCTIONS[payload.action]
    messages = [
        {
            "role": "system",
            "content": (
                "You edit website copy for Auto-AI. Return only the proposed replacement text. "
                "Do not use Markdown, quotation marks, HTML, scripts, URLs, commentary, or explanations."
            ),
        },
        {"role": "user", "content": f"{instruction}\n\nOriginal copy:\n{payload.text}"},
    ]
    enforce_user_quota(db, actor, estimated_input_tokens=max(1, len(payload.text) // 4))
    suggestion, _, model = groq_service.complete(messages, temperature=0.25, max_tokens=800)
    suggestion = suggestion.strip().strip('"').strip("'")
    if not suggestion or len(suggestion) > 5000:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="AI returned an invalid suggestion")
    suggestion = reject_unsafe_markup(suggestion)
    charged = billable_usage()
    record_usage_log(db, actor.id, "cms_ai_assist", model, charged)
    track_quota_usage(db, actor.id, charged["total_tokens"])
    db.commit()
    return {"suggestion": suggestion, "model": model}


@admin_router.get("/pages")
def list_pages(
    search: str = Query(default="", max_length=100),
    status_filter: str = Query(default="", alias="status", pattern="^(|draft|published|scheduled|archived)$"),
    page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100),
    _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db),
) -> dict:
    ensure_cms_defaults(db)
    publish_due(db)
    query = select(ContentPage)
    count_query = select(func.count()).select_from(ContentPage)
    conditions = []
    if search:
        term = f"%{search.strip().lower()}%"
        conditions.append(or_(func.lower(ContentPage.title).like(term), func.lower(ContentPage.slug).like(term)))
    if status_filter:
        conditions.append(ContentPage.status == status_filter)
    if conditions:
        query = query.where(*conditions)
        count_query = count_query.where(*conditions)
    items = db.scalars(query.order_by(ContentPage.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return paginated([serialize_page(item) for item in items], db.scalar(count_query) or 0, page, page_size)


@admin_router.post("/pages", status_code=status.HTTP_201_CREATED)
def create_page(payload: ContentPageCreate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = ContentPage(**payload.model_dump())
    item.created_by = actor.id
    item.updated_by = actor.id
    try:
        db.add(item)
        db.flush()
        audit(db, actor, "created", "page", item.id, f"Created {item.title}")
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Page key or slug already exists") from exc
    db.refresh(item)
    return serialize_page(item)


@admin_router.get("/pages/{page_id}")
def page_detail(page_id: str, _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    return serialize_page(get_page(db, page_id))


@admin_router.patch("/pages/{page_id}")
def update_page(page_id: str, payload: ContentPageUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    require_version(item.version, payload.expected_version)
    changes = payload.model_dump(exclude_unset=True, exclude={"expected_version"})
    for key, value in changes.items():
        setattr(item, key, value)
    item.version += 1
    item.status = "draft" if item.status != "archived" else item.status
    item.updated_by = actor.id
    item.updated_at = datetime.utcnow()
    try:
        audit(db, actor, "edited", "page", item.id, "Draft autosaved", {"fields": sorted(changes)})
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Page slug already exists") from exc
    db.refresh(item)
    return serialize_page(item)


@admin_router.put("/pages/{page_id}/draft")
def save_page_draft(page_id: str, payload: CmsDraftUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    if payload.page_id != item.id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Draft page_id does not match the requested page")
    require_version(item.version, payload.expected_version)

    active_blocks = {
        block.id: block
        for block in db.scalars(
            select(ContentBlock).where(ContentBlock.page_id == item.id, ContentBlock.is_deleted.is_(False))
        ).all()
    }
    requested_ids = {block.id for block in payload.blocks if block.id is not None}
    unknown_ids = sorted(requested_ids - set(active_blocks))
    if unknown_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"field": "blocks.id", "message": "Draft contains a block that does not belong to this page"},
        )

    item.title = payload.title
    item.slug = payload.slug
    item.hero_heading = payload.hero_heading
    item.hero_description = payload.hero_description
    item.buttons = [button.model_dump() for button in payload.buttons]
    item.element_overrides = {key: value.model_dump(exclude_none=True) for key, value in payload.element_overrides.items()}
    item.seo = payload.seo.model_dump()

    now = datetime.utcnow()
    for block_id, block in active_blocks.items():
        if block_id not in requested_ids:
            block.is_deleted = True
            block.deleted_at = now

    for position, draft_block in enumerate(payload.blocks):
        if draft_block.id is None:
            block = ContentBlock(page_id=item.id)
            db.add(block)
        else:
            block = active_blocks[draft_block.id]
        block.block_type = draft_block.block_type
        block.content = draft_block.content
        block.position = position
        block.is_visible = draft_block.is_visible
        block.is_deleted = False
        block.deleted_at = None

    item.version += 1
    item.status = "draft" if item.status != "archived" else item.status
    item.updated_by = actor.id
    item.updated_at = now
    try:
        audit(
            db,
            actor,
            "edited",
            "page",
            item.id,
            "Draft saved",
            {"schema_version": payload.schema_version, "block_count": len(payload.blocks)},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Page slug already exists") from exc
    db.refresh(item)
    db.expire(item, ["blocks"])
    return serialize_page(item)


@admin_router.post("/pages/{page_id}/blocks", status_code=status.HTTP_201_CREATED)
def add_block(page_id: str, payload: ContentBlockInput, expected_version: int = Query(ge=1), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, expected_version)
    position = (db.scalar(select(func.max(ContentBlock.position)).where(ContentBlock.page_id == page.id)) or -1) + 1
    block = ContentBlock(page_id=page.id, position=position, **payload.model_dump())
    db.add(block)
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "block_created", "page", page.id, f"Added {block.block_type} block")
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


@admin_router.patch("/pages/{page_id}/blocks/{block_id}")
def update_block(page_id: str, block_id: str, payload: ContentBlockUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, payload.expected_page_version)
    block = get_block(db, page_id, block_id)
    for key, value in payload.model_dump(exclude_unset=True, exclude={"expected_page_version"}).items():
        setattr(block, key, value)
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "block_edited", "page", page.id, f"Edited {block.block_type} block")
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


@admin_router.post("/pages/{page_id}/blocks/{block_id}/duplicate")
def duplicate_block(page_id: str, block_id: str, expected_version: int = Query(ge=1), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, expected_version)
    source = get_block(db, page_id, block_id)
    for item in db.scalars(select(ContentBlock).where(ContentBlock.page_id == page.id, ContentBlock.position > source.position)).all():
        item.position += 1
    db.add(ContentBlock(page_id=page.id, block_type=source.block_type, content=dict(source.content), position=source.position + 1, is_visible=source.is_visible))
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "block_duplicated", "page", page.id, f"Duplicated {source.block_type} block")
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


@admin_router.delete("/pages/{page_id}/blocks/{block_id}")
def delete_block(page_id: str, block_id: str, expected_version: int = Query(ge=1), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, expected_version)
    block = get_block(db, page_id, block_id)
    block.is_deleted = True
    block.deleted_at = datetime.utcnow()
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "block_deleted", "page", page.id, f"Deleted {block.block_type} block")
    db.commit()
    db.expire(page, ["blocks"])
    result = serialize_page(page)
    result["deleted_block_id"] = block.id
    return result


@admin_router.post("/pages/{page_id}/blocks/{block_id}/restore")
def restore_block(page_id: str, block_id: str, expected_version: int = Query(ge=1), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, expected_version)
    block = get_block(db, page_id, block_id)
    block.is_deleted = False
    block.deleted_at = None
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "block_restored", "page", page.id, f"Restored {block.block_type} block")
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


@admin_router.put("/pages/{page_id}/blocks/order")
def reorder_blocks(page_id: str, payload: BlockOrderUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    page = get_page(db, page_id)
    require_version(page.version, payload.expected_page_version)
    blocks = {item.id: item for item in db.scalars(select(ContentBlock).where(ContentBlock.page_id == page.id, ContentBlock.is_deleted.is_(False))).all()}
    if set(payload.block_ids) != set(blocks):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Block order must include every active block exactly once")
    for position, block_id in enumerate(payload.block_ids):
        blocks[block_id].position = position
    page.version += 1
    page.status = "draft"
    page.updated_by = actor.id
    audit(db, actor, "blocks_reordered", "page", page.id, "Reordered content blocks")
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


@admin_router.get("/pages/{page_id}/preview")
def preview_page(page_id: str, _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    return {"preview": page_snapshot(item), "status": item.status, "version": item.version, "authenticated": True}


@admin_router.post("/pages/{page_id}/publish")
def publish_page_endpoint(page_id: str, payload: PublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    require_version(item.version, payload.expected_version)
    return serialize_page(publish_page(db, item, actor, payload.change_summary, payload.scheduled_at))


@admin_router.post("/pages/{page_id}/unpublish")
def unpublish_page(page_id: str, payload: PublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    require_version(item.version, payload.expected_version)
    item.status = "draft"
    item.scheduled_at = None
    item.published_snapshot = None
    item.version += 1
    item.updated_by = actor.id
    create_revision(db, actor, "page", item.id, "unpublished", item.status, item.version, page_snapshot(item), payload.change_summary or "Unpublished")
    audit(db, actor, "unpublished", "page", item.id, payload.change_summary or "Unpublished")
    db.commit()
    published_cache.invalidate("page:")
    return serialize_page(item)


@admin_router.post("/pages/{page_id}/archive")
def archive_page(page_id: str, payload: PublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = get_page(db, page_id)
    require_version(item.version, payload.expected_version)
    item.status = "archived"
    item.scheduled_at = None
    item.published_snapshot = None
    item.version += 1
    item.updated_by = actor.id
    create_revision(db, actor, "page", item.id, "archived", item.status, item.version, page_snapshot(item), payload.change_summary or "Archived")
    audit(db, actor, "archived", "page", item.id, payload.change_summary or "Archived")
    db.commit()
    published_cache.invalidate("page:")
    return serialize_page(item)


@admin_router.get("/revisions")
def list_revisions(
    content_type: str = Query(default="", max_length=32), content_id: str = Query(default="", max_length=36),
    page: int = Query(default=1, ge=1), page_size: int = Query(default=25, ge=1, le=100),
    _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db),
) -> dict:
    query = select(ContentRevision)
    count_query = select(func.count()).select_from(ContentRevision)
    conditions = []
    if content_type:
        conditions.append(ContentRevision.content_type == content_type)
    if content_id:
        conditions.append(ContentRevision.content_id == content_id)
    if conditions:
        query = query.where(*conditions)
        count_query = count_query.where(*conditions)
    revisions = db.scalars(query.order_by(ContentRevision.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return paginated([revision_payload(db, item) for item in revisions], db.scalar(count_query) or 0, page, page_size)


@admin_router.get("/revisions/{revision_id}")
def revision_detail(revision_id: str, _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    revision = db.get(ContentRevision, revision_id)
    if not revision:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Revision not found")
    return revision_payload(db, revision)


@admin_router.post("/revisions/{revision_id}/restore")
def restore_revision(revision_id: str, payload: RestoreRevisionRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    revision = db.get(ContentRevision, revision_id)
    if not revision or revision.content_type != "page":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page revision not found")
    page = get_page(db, revision.content_id)
    require_version(page.version, payload.expected_version)
    snapshot = revision.snapshot
    for field in ("title", "slug", "hero_heading", "hero_description", "buttons", "element_overrides", "seo"):
        if field in snapshot:
            setattr(page, field, snapshot[field])
    for block in list(page.blocks):
        db.delete(block)
    db.flush()
    for position, block_data in enumerate(snapshot.get("blocks", [])):
        db.add(ContentBlock(
            page_id=page.id, block_type=block_data["block_type"], content=block_data.get("content", {}),
            position=position, is_visible=block_data.get("is_visible", True),
        ))
    page.status = "draft"
    page.version += 1
    page.updated_by = actor.id
    restored = {**snapshot, "restored_from_revision": revision.id}
    create_revision(db, actor, "page", page.id, "restored", "draft", page.version, restored, payload.change_summary)
    audit(db, actor, "restored", "page", page.id, payload.change_summary, {"revision_id": revision.id})
    db.commit()
    db.expire(page, ["blocks"])
    return serialize_page(page)


def list_text_entries(db: Session, model, ui_text: bool, search: str, group: str) -> list[dict]:
    query = select(model)
    conditions = []
    if search:
        term = f"%{search.strip().lower()}%"
        text_column = model.default_text if ui_text else model.default_value
        conditions.append(or_(func.lower(model.key).like(term), func.lower(text_column).like(term)))
    if group:
        conditions.append(model.group == group)
    if conditions:
        query = query.where(*conditions)
    return [serialize_text_entry(item, ui_text) for item in db.scalars(query.order_by(model.group, model.key)).all()]


@admin_router.get("/global-content")
def global_content(search: str = Query(default="", max_length=100), group: str = Query(default="", max_length=48), _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> list[dict]:
    ensure_cms_defaults(db)
    return list_text_entries(db, GlobalContent, False, search, group)


@admin_router.get("/ui-text")
def ui_text(search: str = Query(default="", max_length=100), group: str = Query(default="", max_length=48), _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> list[dict]:
    ensure_cms_defaults(db)
    return list_text_entries(db, UiTextEntry, True, search, group)


def update_text_record(db: Session, actor: User, item, payload: TextEntryUpdate, ui_text_value: bool) -> dict:
    require_version(item.version, payload.expected_version)
    setattr(item, "draft_text" if ui_text_value else "draft_value", payload.value)
    item.status = "draft"
    item.version += 1
    item.updated_by = actor.id
    audit(db, actor, "edited", "ui_text" if ui_text_value else "global", item.id, f"Updated {item.key}")
    db.commit()
    return serialize_text_entry(item, ui_text_value)


def publish_text_record(db: Session, actor: User, item, payload: TextPublishRequest, ui_text_value: bool) -> dict:
    require_version(item.version, payload.expected_version)
    value = getattr(item, "draft_text" if ui_text_value else "draft_value")
    setattr(item, "published_text" if ui_text_value else "published_value", value)
    item.status = "published"
    item.published_at = datetime.utcnow()
    item.version += 1
    item.updated_by = actor.id
    snapshot = {"key": item.key, "locale": item.locale, "value": value}
    content_type = "ui_text" if ui_text_value else "global"
    create_revision(db, actor, content_type, item.id, "published", "published", item.version, snapshot, payload.change_summary)
    audit(db, actor, "published", content_type, item.id, payload.change_summary)
    db.commit()
    published_cache.invalidate(content_type)
    return serialize_text_entry(item, ui_text_value)


@admin_router.patch("/global-content/{entry_id}")
def update_global(entry_id: str, payload: TextEntryUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(GlobalContent, entry_id)
    if not item: raise HTTPException(status_code=404, detail="Global content not found")
    return update_text_record(db, actor, item, payload, False)


@admin_router.post("/global-content/{entry_id}/publish")
def publish_global(entry_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(GlobalContent, entry_id)
    if not item: raise HTTPException(status_code=404, detail="Global content not found")
    return publish_text_record(db, actor, item, payload, False)


@admin_router.post("/global-content/{entry_id}/reset")
def reset_global(entry_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(GlobalContent, entry_id)
    if not item: raise HTTPException(status_code=404, detail="Global content not found")
    return update_text_record(db, actor, item, TextEntryUpdate(value=item.default_value, expected_version=payload.expected_version), False)


@admin_router.patch("/ui-text/{entry_id}")
def update_ui_text(entry_id: str, payload: TextEntryUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(UiTextEntry, entry_id)
    if not item or item.key not in UI_TEXT_DEFAULTS: raise HTTPException(status_code=404, detail="Approved UI text key not found")
    return update_text_record(db, actor, item, payload, True)


@admin_router.post("/ui-text/{entry_id}/publish")
def publish_ui_text(entry_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(UiTextEntry, entry_id)
    if not item or item.key not in UI_TEXT_DEFAULTS: raise HTTPException(status_code=404, detail="Approved UI text key not found")
    return publish_text_record(db, actor, item, payload, True)


@admin_router.post("/ui-text/{entry_id}/reset")
def reset_ui_text(entry_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(UiTextEntry, entry_id)
    if not item or item.key not in UI_TEXT_DEFAULTS: raise HTTPException(status_code=404, detail="Approved UI text key not found")
    return update_text_record(db, actor, item, TextEntryUpdate(value=item.default_text, expected_version=payload.expected_version), True)


@admin_router.get("/faqs")
def list_faqs(search: str = Query(default="", max_length=100), category: str = Query(default="", max_length=80), _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> list[dict]:
    ensure_cms_defaults(db)
    query = select(FaqEntry)
    if search:
        term = f"%{search.strip().lower()}%"
        query = query.where(or_(func.lower(FaqEntry.question).like(term), func.lower(FaqEntry.answer).like(term)))
    if category:
        query = query.where(FaqEntry.category == category)
    return [serialize_faq(item) for item in db.scalars(query.order_by(FaqEntry.position, FaqEntry.updated_at.desc())).all()]


@admin_router.post("/faqs", status_code=status.HTTP_201_CREATED)
def create_faq(payload: FaqCreate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = FaqEntry(**payload.model_dump(), created_by=actor.id, updated_by=actor.id)
    db.add(item); db.flush(); audit(db, actor, "created", "faq", item.id, "Created FAQ"); db.commit(); db.refresh(item)
    return serialize_faq(item)


@admin_router.patch("/faqs/{faq_id}")
def update_faq(faq_id: str, payload: FaqUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(FaqEntry, faq_id)
    if not item: raise HTTPException(status_code=404, detail="FAQ not found")
    require_version(item.version, payload.expected_version)
    for key, value in payload.model_dump(exclude_unset=True, exclude={"expected_version"}).items(): setattr(item, key, value)
    item.status = "draft"; item.version += 1; item.updated_by = actor.id
    audit(db, actor, "edited", "faq", item.id, "Updated FAQ"); db.commit(); db.refresh(item)
    return serialize_faq(item)


@admin_router.post("/faqs/{faq_id}/publish")
def publish_faq(faq_id: str, payload: PublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(FaqEntry, faq_id)
    if not item: raise HTTPException(status_code=404, detail="FAQ not found")
    require_version(item.version, payload.expected_version)
    now = datetime.utcnow(); snapshot = faq_snapshot(item)
    if payload.scheduled_at and payload.scheduled_at > now:
        item.status = "scheduled"; item.scheduled_at = payload.scheduled_at; action = "scheduled"
    else:
        item.status = "published"; item.published_snapshot = snapshot; item.published_at = now; item.scheduled_at = None; action = "published"
    item.version += 1; item.updated_by = actor.id
    create_revision(db, actor, "faq", item.id, action, item.status, item.version, snapshot, payload.change_summary or action.title())
    audit(db, actor, action, "faq", item.id, payload.change_summary or action.title()); db.commit(); published_cache.invalidate("faqs")
    return serialize_faq(item)


@admin_router.post("/faqs/{faq_id}/archive")
def archive_faq(faq_id: str, payload: PublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(FaqEntry, faq_id)
    if not item: raise HTTPException(status_code=404, detail="FAQ not found")
    require_version(item.version, payload.expected_version)
    item.status = "archived"; item.scheduled_at = None; item.version += 1; item.updated_by = actor.id
    item.published_snapshot = None
    create_revision(db, actor, "faq", item.id, "archived", "archived", item.version, faq_snapshot(item), payload.change_summary or "Archived")
    audit(db, actor, "archived", "faq", item.id, payload.change_summary or "Archived"); db.commit(); published_cache.invalidate("faqs")
    return serialize_faq(item)


@admin_router.get("/announcements")
def list_announcements(_: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> list[dict]:
    publish_due(db)
    return [serialize_announcement(item) for item in db.scalars(select(Announcement).order_by(Announcement.updated_at.desc())).all()]


@admin_router.post("/announcements", status_code=status.HTTP_201_CREATED)
def create_announcement(payload: AnnouncementCreate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = Announcement(**payload.model_dump(), created_by=actor.id, updated_by=actor.id)
    db.add(item); db.flush(); audit(db, actor, "created", "announcement", item.id, "Created announcement"); db.commit(); db.refresh(item)
    return serialize_announcement(item)


@admin_router.patch("/announcements/{item_id}")
def update_announcement(item_id: str, payload: AnnouncementUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(Announcement, item_id)
    if not item: raise HTTPException(status_code=404, detail="Announcement not found")
    require_version(item.version, payload.expected_version)
    for key, value in payload.model_dump(exclude={"expected_version"}).items(): setattr(item, key, value)
    item.status = "draft"; item.version += 1; item.updated_by = actor.id
    audit(db, actor, "edited", "announcement", item.id, "Updated announcement"); db.commit(); db.refresh(item)
    return serialize_announcement(item)


@admin_router.post("/announcements/{item_id}/publish")
def publish_announcement(item_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(Announcement, item_id)
    if not item: raise HTTPException(status_code=404, detail="Announcement not found")
    require_version(item.version, payload.expected_version)
    item.status = "scheduled" if item.start_at and item.start_at > datetime.utcnow() else "published"; item.version += 1; item.updated_by = actor.id
    item.published_snapshot = announcement_snapshot(item)
    snapshot = item.published_snapshot
    action = "scheduled" if item.status == "scheduled" else "published"
    create_revision(db, actor, "announcement", item.id, action, item.status, item.version, snapshot, payload.change_summary)
    audit(db, actor, action, "announcement", item.id, payload.change_summary); db.commit(); published_cache.invalidate("announcements")
    return serialize_announcement(item)


@admin_router.post("/announcements/{item_id}/archive")
def archive_announcement(item_id: str, payload: TextPublishRequest, actor: User = Depends(get_current_cms_publisher), db: Session = Depends(get_db)) -> dict:
    item = db.get(Announcement, item_id)
    if not item: raise HTTPException(status_code=404, detail="Announcement not found")
    require_version(item.version, payload.expected_version)
    item.status = "archived"; item.published_snapshot = None; item.version += 1; item.updated_by = actor.id
    create_revision(db, actor, "announcement", item.id, "archived", "archived", item.version, serialize_announcement(item), payload.change_summary or "Archived")
    audit(db, actor, "archived", "announcement", item.id, payload.change_summary or "Archived"); db.commit(); published_cache.invalidate("announcements")
    return serialize_announcement(item)


def media_directory() -> Path:
    directory = (Path(settings.UPLOAD_DIR) / "cms").resolve()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def valid_image(content: bytes, suffix: str) -> bool:
    if suffix in {".jpg", ".jpeg"}: return content.startswith(b"\xff\xd8\xff")
    if suffix == ".png": return content.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix == ".webp": return len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    return False


async def store_media(file: UploadFile) -> tuple[str, str, str, int, str]:
    suffix = Path(file.filename or "").suffix.lower()
    if file.content_type not in ALLOWED_IMAGE_TYPES or suffix not in ALLOWED_IMAGE_SUFFIXES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Media must be JPG, PNG or WebP")
    content = await file.read(MAX_MEDIA_BYTES + 1)
    if len(content) > MAX_MEDIA_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Media must be 8 MB or smaller")
    if not valid_image(content, suffix):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Uploaded file is not a valid image")
    extension = ".jpg" if suffix == ".jpeg" else suffix
    filename = f"{uuid.uuid4().hex}{extension}"
    directory = media_directory(); target = (directory / filename).resolve()
    try: target.relative_to(directory)
    except ValueError as exc: raise HTTPException(status_code=400, detail="Invalid media path") from exc
    target.write_bytes(content)
    return filename, str(target), f"/uploads/cms/{filename}", len(content), hashlib.sha256(content).hexdigest()


@admin_router.get("/media")
def list_media(search: str = Query(default="", max_length=100), page: int = Query(default=1, ge=1), page_size: int = Query(default=24, ge=1, le=100), _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    query = select(MediaAsset); count_query = select(func.count()).select_from(MediaAsset)
    if search:
        term = f"%{search.strip().lower()}%"; condition = or_(func.lower(MediaAsset.filename).like(term), func.lower(MediaAsset.alt_text).like(term))
        query = query.where(condition); count_query = count_query.where(condition)
    items = db.scalars(query.order_by(MediaAsset.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    return paginated([serialize_media(item, media_usage_count(db, item)) for item in items], db.scalar(count_query) or 0, page, page_size)


@admin_router.post("/media", status_code=status.HTTP_201_CREATED)
async def upload_media(file: UploadFile = File(...), alt_text: str = Form(default="", max_length=300), caption: str = Form(default="", max_length=500), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    filename, path, url, size, checksum = await store_media(file)
    item = MediaAsset(filename=filename, storage_path=path, public_url=url, mime_type=file.content_type or "image/jpeg", file_size=size, alt_text=alt_text.strip(), caption=caption.strip(), checksum_sha256=checksum, uploaded_by=actor.id)
    db.add(item); db.flush(); audit(db, actor, "uploaded", "media", item.id, f"Uploaded {filename}"); db.commit(); db.refresh(item)
    return serialize_media(item)


@admin_router.patch("/media/{asset_id}")
def update_media(asset_id: str, payload: MediaMetadataUpdate, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(MediaAsset, asset_id)
    if not item: raise HTTPException(status_code=404, detail="Media asset not found")
    item.alt_text = payload.alt_text; item.caption = payload.caption
    audit(db, actor, "edited", "media", item.id, "Updated media metadata"); db.commit(); db.refresh(item)
    return serialize_media(item, media_usage_count(db, item))


@admin_router.post("/media/{asset_id}/replace")
async def replace_media(asset_id: str, file: UploadFile = File(...), actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> dict:
    item = db.get(MediaAsset, asset_id)
    if not item: raise HTTPException(status_code=404, detail="Media asset not found")
    _filename, path, _url, size, checksum = await store_media(file)
    old_path = Path(item.storage_path)
    new_path = Path(path)
    if new_path.suffix.lower() != old_path.suffix.lower():
        new_path.unlink(missing_ok=True)
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Replacement must use the same image format to preserve its public URL")
    new_path.replace(old_path)
    item.mime_type = file.content_type or item.mime_type; item.file_size = size; item.checksum_sha256 = checksum
    audit(db, actor, "replaced", "media", item.id, f"Replaced {item.filename} safely"); db.commit(); db.refresh(item)
    return serialize_media(item, media_usage_count(db, item))


@admin_router.delete("/media/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_media(asset_id: str, actor: User = Depends(get_current_cms_editor), db: Session = Depends(get_db)) -> Response:
    item = db.get(MediaAsset, asset_id)
    if not item: raise HTTPException(status_code=404, detail="Media asset not found")
    usage = media_usage_count(db, item)
    if usage:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"code": "media_in_use", "usage_count": usage})
    path = Path(item.storage_path); audit(db, actor, "deleted", "media", item.id, f"Deleted {item.filename}"); db.delete(item); db.commit(); path.unlink(missing_ok=True)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_router.get("/audit")
def audit_log(page: int = Query(default=1, ge=1), page_size: int = Query(default=50, ge=1, le=100), _: User = Depends(get_current_cms_viewer), db: Session = Depends(get_db)) -> dict:
    total = db.scalar(select(func.count()).select_from(ContentAuditLog)) or 0
    rows = db.scalars(select(ContentAuditLog).order_by(ContentAuditLog.created_at.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for row in rows:
        actor = db.get(User, row.actor_id) if row.actor_id else None
        items.append({"id": row.id, "actor_id": row.actor_id, "administrator": actor.name if actor else "System", "action": row.action, "content_type": row.content_type, "content_id": row.content_id, "summary": row.summary, "metadata": row.metadata_json, "created_at": row.created_at})
    return paginated(items, total, page, page_size)


@public_router.get("/pages/{slug:path}")
def public_page(slug: str, db: Session = Depends(get_db)) -> dict:
    publish_due(db)
    normalized = slug.strip("/") or "home"
    key = f"page:{normalized}"
    cached = published_cache.get(key)
    if cached is not None: return cached
    item = db.scalar(select(ContentPage).where(ContentPage.published_slug == normalized, ContentPage.published_snapshot.is_not(None)))
    if not item: raise HTTPException(status_code=404, detail="Published page not found")
    result = serialize_page(item, include_draft=False); published_cache.set(key, result); return result


@public_router.get("/global")
def public_global(locale: str = Query(default="en", max_length=12), db: Session = Depends(get_db)) -> dict:
    key = f"global:{locale}"; cached = published_cache.get(key)
    if cached is not None: return cached
    rows = db.scalars(select(GlobalContent).where(GlobalContent.locale == locale, GlobalContent.published_value.is_not(None))).all()
    result = {row.key: row.published_value for row in rows}; published_cache.set(key, result); return result


@public_router.get("/ui-text")
def public_ui_text(locale: str = Query(default="en", max_length=12), db: Session = Depends(get_db)) -> dict:
    key = f"ui_text:{locale}"; cached = published_cache.get(key)
    if cached is not None: return cached
    rows = db.scalars(select(UiTextEntry).where(UiTextEntry.locale == locale, UiTextEntry.published_text.is_not(None))).all()
    result = {row.key: row.published_text for row in rows}; published_cache.set(key, result); return result


@public_router.get("/faqs")
def public_faqs(category: str = Query(default="", max_length=80), db: Session = Depends(get_db)) -> list[dict]:
    publish_due(db); key = f"faqs:{category}"; cached = published_cache.get(key)
    if cached is not None: return cached
    query = select(FaqEntry).where(FaqEntry.published_snapshot.is_not(None))
    if category: query = query.where(FaqEntry.category == category)
    result = [serialize_faq(item, include_draft=False) for item in db.scalars(query.order_by(FaqEntry.position)).all()]
    result = [item for item in result if item.get("enabled", True)]
    published_cache.set(key, result); return result


@public_router.get("/announcements")
def public_announcements(target: str = Query(default="website", pattern="^(website|android)$"), audience: str = Query(default="all", pattern="^(all|free|paid|admin)$"), db: Session = Depends(get_db)) -> list[dict]:
    publish_due(db)
    now = datetime.utcnow()
    rows = db.scalars(select(Announcement).where(Announcement.published_snapshot.is_not(None)).order_by(Announcement.created_at.desc())).all()
    result = []
    for item in rows:
        snapshot = item.published_snapshot or {}
        if snapshot.get("targets") not in {target, "both"} or snapshot.get("audience") not in {"all", audience}:
            continue
        start_at = snapshot.get("start_at")
        end_at = snapshot.get("end_at")
        if isinstance(start_at, str): start_at = datetime.fromisoformat(start_at)
        if isinstance(end_at, str): end_at = datetime.fromisoformat(end_at)
        if (start_at and start_at > now) or (end_at and end_at <= now):
            continue
        result.append({**snapshot, "status": "published", "version": item.version, "updated_at": item.updated_at})
    return result


@public_router.get("/sitemap.xml")
def public_cms_sitemap(db: Session = Depends(get_db)) -> Response:
    publish_due(db)
    urls = []
    for page in db.scalars(select(ContentPage).where(ContentPage.published_snapshot.is_not(None)).order_by(ContentPage.published_slug)).all():
        snapshot = page.published_snapshot or {}
        seo = snapshot.get("seo") or {}
        if not seo.get("sitemap", True):
            continue
        canonical = seo.get("canonical_url") or f"{settings.frontend_url.rstrip('/')}/{'' if page.published_slug == 'home' else page.published_slug}"
        lastmod = (page.published_at or page.updated_at).date().isoformat()
        urls.append(f"  <url><loc>{escape(str(canonical))}</loc><lastmod>{lastmod}</lastmod></url>")
    body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "\n".join(urls) + "\n</urlset>"
    return Response(content=body, media_type="application/xml")


router.include_router(admin_router)
router.include_router(public_router)
