from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import json
from threading import Lock
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.cms import (
    Announcement,
    ContentAuditLog,
    ContentBlock,
    ContentPage,
    ContentRevision,
    FaqEntry,
    GlobalContent,
    MediaAsset,
    UiTextEntry,
)
from app.models.user import User


CMS_VIEW_ROLES = {"admin", "super_admin", "content_admin", "content_editor", "content_viewer"}
CMS_EDIT_ROLES = {"admin", "super_admin", "content_admin", "content_editor"}
CMS_PUBLISH_ROLES = {"admin", "super_admin", "content_admin"}

PAGE_DEFAULTS = [
    {
        "page_key": "home",
        "title": "Home",
        "slug": "home",
        "hero_heading": "Auto-AI",
        "hero_description": "Auto-AI, also known as AutoAI and Auto AI, is a commercial-grade AI experience with memory, uploads, voice, streaming, and a conversation style that feels alive.",
        "buttons": [
            {"label": "Start building", "url": "/register", "style": "primary"},
            {"label": "View workspace", "url": "/login", "style": "secondary"},
        ],
        "seo": {
            "title": "Auto-AI | AutoAI Workspace for AI Chat, Memory and Files",
            "description": "Auto-AI is an AI workspace with memory, uploads, voice input, web research, streaming chat, and Android access.",
            "canonical_url": "https://autoai.site.je/",
            "og_title": "Auto-AI",
            "og_description": "A contextual AI workspace for web and Android.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [
            {"block_type": "heading", "content": {"text": "Every interaction has weight, motion, and memory."}},
            {"block_type": "feature_grid", "content": {"title": "Product System"}},
            {"block_type": "call_to_action", "content": {"heading": "Bring the whole workspace into one conversation.", "button_text": "Create account", "url": "/register"}},
        ],
    },
    {
        "page_key": "pricing",
        "title": "Pricing",
        "slug": "pricing",
        "hero_heading": "Auto-AI Pricing",
        "hero_description": "Choose a plan and pay securely using UPI, cards or wallet.",
        "buttons": [],
        "seo": {
            "title": "Auto-AI Pricing | Free, Pro, Premium and Ultra Plans",
            "description": "Compare Auto-AI plans and monthly token quotas.",
            "canonical_url": "https://autoai.site.je/pricing",
            "og_title": "Auto-AI Pricing",
            "og_description": "Free, Pro, Premium and Ultra plans.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "pricing_description", "content": {"text": "Flexible plans for every workload."}}],
    },
    {
        "page_key": "download",
        "title": "Download App",
        "slug": "download",
        "hero_heading": "Auto-AI Mobile",
        "hero_description": "Install Auto-AI on Android with the same backend, account, memory, chat history, uploads, settings, and source-grounded answers as the website.",
        "buttons": [{"label": "Download Auto-AI APK", "url": "/api/download/apk", "style": "primary"}],
        "seo": {
            "title": "Download Auto-AI Android APK | AutoAI Mobile App",
            "description": "Download the Auto-AI Android APK and use the same account and workspace on mobile.",
            "canonical_url": "https://autoai.site.je/download",
            "og_title": "Download Auto-AI",
            "og_description": "Auto-AI for Android.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "download_button", "content": {"label": "Download Auto-AI APK", "url": "/api/download/apk"}}],
    },
    {
        "page_key": "about",
        "title": "About",
        "slug": "about",
        "hero_heading": "About Auto-AI",
        "hero_description": "Auto-AI brings chat, memory, voice, file context and mobile access into one workspace.",
        "buttons": [{"label": "Start now", "url": "/register", "style": "primary"}],
        "seo": {
            "title": "About Auto-AI",
            "description": "Learn about Auto-AI, the AI workspace for chat, voice, files and Android.",
            "canonical_url": "https://autoai.site.je/about",
            "og_title": "About Auto-AI",
            "og_description": "AI workspace for web and Android.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "paragraph", "content": {"text": "Auto-AI is designed for fast, contextual work across devices."}}],
    },
    {
        "page_key": "features",
        "title": "Features",
        "slug": "features",
        "hero_heading": "Auto-AI Features",
        "hero_description": "Everything you need for useful AI conversations, research, uploads and mobile continuity.",
        "buttons": [{"label": "Open workspace", "url": "/login", "style": "primary"}],
        "seo": {
            "title": "Auto-AI Features",
            "description": "Explore Auto-AI features including chat, memory, uploads, voice, research and Android support.",
            "canonical_url": "https://autoai.site.je/features",
            "og_title": "Auto-AI Features",
            "og_description": "Chat, memory, uploads and voice in one AI workspace.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "feature_grid", "content": {"title": "Core features", "items": ["Streaming chat", "File uploads", "Voice input", "Android access"]}}],
    },
    {
        "page_key": "contact",
        "title": "Contact",
        "slug": "contact",
        "hero_heading": "Contact Auto-AI",
        "hero_description": "Reach the Auto-AI team for support, billing and product questions.",
        "buttons": [{"label": "Email support", "url": "mailto:support@autoai.site.je", "style": "primary"}],
        "seo": {
            "title": "Contact Auto-AI",
            "description": "Contact Auto-AI support for product and billing help.",
            "canonical_url": "https://autoai.site.je/contact",
            "og_title": "Contact Auto-AI",
            "og_description": "Get Auto-AI support.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "contact_section", "content": {"heading": "Support", "email": "support@autoai.site.je"}}],
    },
    {
        "page_key": "help",
        "title": "Help",
        "slug": "help",
        "hero_heading": "Auto-AI Help",
        "hero_description": "Find answers about accounts, chat, billing, Android and content features.",
        "buttons": [],
        "seo": {
            "title": "Auto-AI Help",
            "description": "Help and FAQ for Auto-AI users.",
            "canonical_url": "https://autoai.site.je/help",
            "og_title": "Auto-AI Help",
            "og_description": "Answers for Auto-AI users.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "faq", "content": {"question": "Where do I start?", "answer": "Create an account, sign in, and begin a new chat."}}],
    },
    {
        "page_key": "privacy",
        "title": "Privacy Policy",
        "slug": "privacy-policy",
        "hero_heading": "Privacy Policy",
        "hero_description": "How Auto-AI handles account, content and usage information.",
        "buttons": [],
        "seo": {
            "title": "Auto-AI Privacy Policy",
            "description": "Auto-AI privacy policy.",
            "canonical_url": "https://autoai.site.je/privacy-policy",
            "og_title": "Privacy Policy",
            "og_description": "Auto-AI privacy information.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "paragraph", "content": {"text": "This page can be updated by an authorized content administrator."}}],
    },
    {
        "page_key": "terms",
        "title": "Terms and Conditions",
        "slug": "terms-and-conditions",
        "hero_heading": "Terms and Conditions",
        "hero_description": "Terms governing use of Auto-AI services.",
        "buttons": [],
        "seo": {
            "title": "Auto-AI Terms and Conditions",
            "description": "Auto-AI terms and conditions.",
            "canonical_url": "https://autoai.site.je/terms-and-conditions",
            "og_title": "Terms and Conditions",
            "og_description": "Auto-AI service terms.",
            "og_image": "/icons/icon-512.png",
            "robots_index": True,
            "sitemap": True,
        },
        "blocks": [{"block_type": "paragraph", "content": {"text": "This page can be updated by an authorized content administrator."}}],
    },
]

GLOBAL_DEFAULTS = {
    "site.name": ("brand", "Auto-AI"),
    "header.features": ("header", "Features"),
    "header.android": ("header", "Android"),
    "header.pricing": ("header", "Pricing"),
    "header.admin": ("header", "Admin"),
    "header.faq": ("header", "FAQ"),
    "header.sign_in": ("header", "Sign in"),
    "footer.description": ("footer", "Premium AI workspace for contextual, human-feeling conversations."),
    "footer.copyright": ("footer", "Copyright Auto-AI. All rights reserved."),
    "contact.email": ("contact", "support@autoai.site.je"),
    "support.url": ("support", "/#faq"),
    "app.download_text": ("download", "Download Auto-AI APK"),
    "cta.default": ("cta", "Create account"),
}

UI_TEXT_DEFAULTS = {
    "auth.login.title": ("Login", "Welcome back"),
    "auth.login.email": ("Login", "Email"),
    "auth.login.password": ("Login", "Password"),
    "auth.login.submit": ("Login", "Sign in"),
    "auth.signup.title": ("Signup", "Create your account"),
    "auth.signup.submit": ("Signup", "Create account"),
    "chat.welcome": ("Chat", "How can I help you today?"),
    "chat.empty": ("Chat", "Start a new conversation"),
    "chat.send": ("Chat", "Send message"),
    "billing.upgrade": ("Billing", "Upgrade plan"),
    "download.prompt": ("Download", "Download Auto-AI APK"),
    "validation.required": ("Validation", "This field is required."),
}

FAQ_DEFAULTS = [
    ("Does Auto-AI remember me?", "Auto-AI can retain approved preferences and project context to make future conversations more useful."),
    ("Can I chat with files?", "Yes. Auto-AI supports PDF, DOCX, TXT and image context in the chat workspace."),
    ("Which providers are supported?", "Available AI providers depend on the administrator configuration and your plan."),
]


class PublishedContentCache:
    def __init__(self) -> None:
        self._lock = Lock()
        self._values: dict[str, Any] = {}

    def get(self, key: str) -> Any | None:
        with self._lock:
            value = self._values.get(key)
            return deepcopy(value) if value is not None else None

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._values[key] = deepcopy(value)

    def invalidate(self, prefix: str = "") -> None:
        with self._lock:
            if not prefix:
                self._values.clear()
            else:
                for key in [item for item in self._values if item.startswith(prefix)]:
                    self._values.pop(key, None)


published_cache = PublishedContentCache()


def ensure_cms_defaults(db: Session) -> None:
    for page_data in PAGE_DEFAULTS:
        existing = db.scalar(select(ContentPage.id).where(ContentPage.page_key == page_data["page_key"]))
        slug_owner = db.scalar(select(ContentPage.id).where(ContentPage.slug == page_data["slug"]))
        if existing or slug_owner:
            continue
        blocks = page_data["blocks"]
        page = ContentPage(**{key: value for key, value in page_data.items() if key != "blocks"})
        db.add(page)
        db.flush()
        for position, block in enumerate(blocks):
            db.add(ContentBlock(page_id=page.id, position=position, **block))
    for key, (group, value) in GLOBAL_DEFAULTS.items():
        if not db.scalar(select(GlobalContent.id).where(GlobalContent.key == key, GlobalContent.locale == "en")):
            db.add(GlobalContent(key=key, group=group, default_value=value, draft_value=value))
    for key, (group, value) in UI_TEXT_DEFAULTS.items():
        if not db.scalar(select(UiTextEntry.id).where(UiTextEntry.key == key, UiTextEntry.locale == "en")):
            db.add(UiTextEntry(key=key, group=group, default_text=value, draft_text=value))
    if not db.scalar(select(FaqEntry.id).limit(1)):
        for position, (question, answer) in enumerate(FAQ_DEFAULTS):
            db.add(FaqEntry(question=question, answer=answer, category="General", position=position))
    db.commit()


def require_version(current: int, expected: int) -> None:
    if current != expected:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "editing_conflict", "message": "Content changed on the server.", "server_version": current},
        )


def audit(db: Session, actor: User, action: str, content_type: str, content_id: str, summary: str = "", metadata: dict | None = None) -> None:
    db.add(ContentAuditLog(
        actor_id=actor.id,
        action=action,
        content_type=content_type,
        content_id=content_id,
        summary=summary[:255],
        metadata_json=metadata or {},
    ))


def page_snapshot(page: ContentPage) -> dict[str, Any]:
    blocks = sorted((block for block in page.blocks if not block.is_deleted), key=lambda block: block.position)
    return {
        "id": page.id,
        "page_key": page.page_key,
        "title": page.title,
        "slug": page.slug,
        "hero_heading": page.hero_heading,
        "hero_description": page.hero_description,
        "buttons": deepcopy(page.buttons or []),
        "seo": deepcopy(page.seo or {}),
        "blocks": [
            {
                "id": block.id,
                "block_type": block.block_type,
                "content": deepcopy(block.content or {}),
                "position": block.position,
                "is_visible": block.is_visible,
            }
            for block in blocks
        ],
    }


def serialize_page(page: ContentPage, include_draft: bool = True) -> dict[str, Any]:
    snapshot = page_snapshot(page) if include_draft else deepcopy(page.published_snapshot or {})
    result = {
        **snapshot,
        "id": page.id,
        "page_key": page.page_key,
        "title": page.title if include_draft else snapshot.get("title", page.title),
        "slug": page.slug if include_draft else snapshot.get("slug", page.published_slug or page.slug),
        "status": page.status if include_draft else "published",
        "version": page.version,
        "scheduled_at": page.scheduled_at,
        "published_at": page.published_at,
        "created_at": page.created_at,
        "updated_at": page.updated_at,
        "updated_by": page.updated_by,
    }
    if include_draft:
        result["deleted_blocks"] = [
            {
                "id": block.id, "block_type": block.block_type, "content": deepcopy(block.content or {}),
                "position": block.position, "is_visible": block.is_visible,
            }
            for block in page.blocks if block.is_deleted
        ]
    return result


def create_revision(db: Session, actor: User, content_type: str, content_id: str, action: str, status_value: str, version: int, snapshot: dict, summary: str) -> ContentRevision:
    revision = ContentRevision(
        content_type=content_type,
        content_id=content_id,
        action=action,
        status=status_value,
        version=version,
        change_summary=summary[:255],
        snapshot=deepcopy(snapshot),
        created_by=actor.id,
    )
    db.add(revision)
    return revision


def publish_page(db: Session, page: ContentPage, actor: User, summary: str, scheduled_at: datetime | None = None) -> ContentPage:
    now = datetime.utcnow()
    snapshot = page_snapshot(page)
    slug_owner = db.scalar(select(ContentPage.id).where(ContentPage.published_slug == page.slug, ContentPage.id != page.id))
    if slug_owner:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Another published page already uses this slug")
    if scheduled_at and scheduled_at > now:
        page.status = "scheduled"
        page.scheduled_at = scheduled_at
        action = "scheduled"
    else:
        page.status = "published"
        page.published_snapshot = snapshot
        page.published_slug = page.slug
        page.published_at = now
        page.scheduled_at = None
        action = "published"
    page.version += 1
    page.updated_by = actor.id
    page.updated_at = now
    create_revision(db, actor, "page", page.id, action, page.status, page.version, snapshot, summary or action.title())
    audit(db, actor, action, "page", page.id, summary or action.title())
    db.commit()
    db.refresh(page)
    published_cache.invalidate("page:")
    return page


def publish_due(db: Session) -> int:
    now = datetime.utcnow()
    pages = db.scalars(select(ContentPage).where(ContentPage.status == "scheduled", ContentPage.scheduled_at <= now)).all()
    count = 0
    for page in pages:
        page.status = "published"
        page.published_snapshot = page_snapshot(page)
        page.published_slug = page.slug
        page.published_at = now
        page.scheduled_at = None
        page.version += 1
        db.add(ContentRevision(
            content_type="page", content_id=page.id, action="published", status="published",
            version=page.version, change_summary="Scheduled publish", snapshot=page.published_snapshot,
            created_by=page.updated_by,
        ))
        db.add(ContentAuditLog(
            actor_id=page.updated_by, action="published", content_type="page", content_id=page.id,
            summary="Scheduled publish", metadata_json={"automatic": True},
        ))
        count += 1
    faqs = db.scalars(select(FaqEntry).where(FaqEntry.status == "scheduled", FaqEntry.scheduled_at <= now)).all()
    for faq in faqs:
        faq.status = "published"
        faq.published_snapshot = faq_snapshot(faq)
        faq.published_at = now
        faq.scheduled_at = None
        faq.version += 1
        db.add(ContentRevision(content_type="faq", content_id=faq.id, action="published", status="published", version=faq.version, change_summary="Scheduled publish", snapshot=faq.published_snapshot, created_by=faq.updated_by))
        db.add(ContentAuditLog(actor_id=faq.updated_by, action="published", content_type="faq", content_id=faq.id, summary="Scheduled publish", metadata_json={"automatic": True}))
        count += 1
    announcements = db.scalars(select(Announcement).where(Announcement.status == "scheduled", Announcement.start_at <= now)).all()
    for item in announcements:
        item.status = "published"
        item.version += 1
        snapshot = item.published_snapshot or announcement_snapshot(item)
        db.add(ContentRevision(content_type="announcement", content_id=item.id, action="published", status="published", version=item.version, change_summary="Scheduled publish", snapshot=snapshot, created_by=item.updated_by))
        db.add(ContentAuditLog(actor_id=item.updated_by, action="published", content_type="announcement", content_id=item.id, summary="Scheduled publish", metadata_json={"automatic": True}))
        count += 1
    if count:
        db.commit()
        published_cache.invalidate()
    return count


def faq_snapshot(faq: FaqEntry) -> dict[str, Any]:
    return {
        "id": faq.id,
        "question": faq.question,
        "answer": faq.answer,
        "category": faq.category,
        "position": faq.position,
        "enabled": faq.enabled,
    }


def serialize_faq(faq: FaqEntry, include_draft: bool = True) -> dict[str, Any]:
    data = faq_snapshot(faq) if include_draft else deepcopy(faq.published_snapshot or {})
    return {
        **data,
        "id": faq.id,
        "status": faq.status if include_draft else "published",
        "version": faq.version,
        "scheduled_at": faq.scheduled_at,
        "published_at": faq.published_at,
        "created_at": faq.created_at,
        "updated_at": faq.updated_at,
        "updated_by": faq.updated_by,
    }


def serialize_text_entry(entry: GlobalContent | UiTextEntry, ui_text: bool = False) -> dict[str, Any]:
    return {
        "id": entry.id,
        "key": entry.key,
        "group": entry.group,
        "locale": entry.locale,
        "default_value": entry.default_text if ui_text else entry.default_value,
        "draft_value": entry.draft_text if ui_text else entry.draft_value,
        "published_value": entry.published_text if ui_text else entry.published_value,
        "status": entry.status,
        "version": entry.version,
        "mandatory": entry.mandatory,
        "updated_by": entry.updated_by,
        "published_at": entry.published_at,
        "updated_at": entry.updated_at,
    }


def serialize_announcement(item: Announcement) -> dict[str, Any]:
    return {
        "id": item.id, "title": item.title, "message": item.message, "action_text": item.action_text,
        "target_url": item.target_url, "start_at": item.start_at, "end_at": item.end_at,
        "status": item.status, "targets": item.targets, "audience": item.audience,
        "dismissible": item.dismissible, "version": item.version, "created_at": item.created_at,
        "updated_at": item.updated_at, "updated_by": item.updated_by,
    }


def announcement_snapshot(item: Announcement) -> dict[str, Any]:
    return {
        "id": item.id, "title": item.title, "message": item.message, "action_text": item.action_text,
        "target_url": item.target_url,
        "start_at": item.start_at.isoformat() if item.start_at else None,
        "end_at": item.end_at.isoformat() if item.end_at else None,
        "targets": item.targets, "audience": item.audience, "dismissible": item.dismissible,
    }


def serialize_media(item: MediaAsset, usage_count: int = 0) -> dict[str, Any]:
    return {
        "id": item.id, "filename": item.filename, "url": item.public_url, "mime_type": item.mime_type,
        "file_size": item.file_size, "alt_text": item.alt_text, "caption": item.caption,
        "checksum_sha256": item.checksum_sha256, "usage_count": usage_count,
        "created_at": item.created_at, "updated_at": item.updated_at,
    }


def media_usage_count(db: Session, asset: MediaAsset) -> int:
    needle = asset.public_url
    count = 0
    for page in db.scalars(select(ContentPage)).all():
        if needle in json.dumps(page_snapshot(page)) or needle in json.dumps(page.published_snapshot or {}):
            count += 1
    for entry in db.scalars(select(GlobalContent)).all():
        if needle in (entry.draft_value or "") or needle in (entry.published_value or ""):
            count += 1
    for announcement in db.scalars(select(Announcement)).all():
        if needle in announcement.message or needle == announcement.target_url:
            count += 1
    return count


def revision_diff(previous: dict | None, current: dict) -> dict[str, Any]:
    previous = previous or {}
    keys = sorted(set(previous) | set(current))
    return {
        key: {"previous": previous.get(key), "new": current.get(key)}
        for key in keys
        if previous.get(key) != current.get(key)
    }
