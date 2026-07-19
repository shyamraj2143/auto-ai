from datetime import datetime, timezone
import re
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ContentStatus = Literal["draft", "published", "scheduled", "archived"]
CmsAiAction = Literal["rewrite", "shorten", "expand", "grammar", "professional", "translate_hindi", "translate_english", "cta", "seo_heading"]
BlockType = Literal[
    "page_section", "container", "one_column", "two_columns", "three_columns", "grid", "stack", "tabs", "accordion",
    "heading", "paragraph", "rich_text", "button", "link", "image", "video_link", "icon", "divider", "spacer",
    "list", "quote", "badge", "feature_card", "feature_grid", "pricing_description", "pricing_cards", "testimonial",
    "testimonials", "faq", "statistics", "call_to_action", "download_button", "app_download", "contact_section",
    "team_section", "announcement_banner", "navigation", "footer", "social_links", "form", "text_input",
    "email_input", "phone_input", "text_area", "radio_group", "checkbox_group", "dropdown", "date_input",
    "submit_button", "success_message", "error_message", "hero_section"
]
BLOCK_TYPES = set(BlockType.__args__)
SAFE_URL_SCHEMES = {"http", "https", "mailto", "tel"}
UNSAFE_MARKUP = re.compile(r"<\s*(script|style|iframe|object|embed|form|input|svg|math)\b|\bon\w+\s*=|(?:javascript|vbscript|data|file)\s*:", re.I)


def validate_safe_url(value: str) -> str:
    value = value.strip()
    if not value:
        return value
    if value.startswith(("/", "#")) and not value.startswith("//"):
        return value
    parsed = urlparse(value)
    if parsed.scheme.lower() not in SAFE_URL_SCHEMES:
        raise ValueError("URL must use HTTPS, HTTP, mailto, tel, a relative path or an anchor")
    if parsed.scheme.lower() in {"http", "https"} and not parsed.netloc:
        raise ValueError("HTTP and HTTPS URLs must include a host")
    return value


def reject_unsafe_markup(value: str) -> str:
    value = value.strip()
    if UNSAFE_MARKUP.search(value):
        raise ValueError("Scripts, embedded code and unsafe URLs are not allowed")
    return value


def utc_naive(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CmsAiAssistRequest(StrictModel):
    action: CmsAiAction
    text: str = Field(min_length=1, max_length=5000)

    _safe_text = field_validator("text")(classmethod(lambda cls, value: reject_unsafe_markup(value)))


class SeoFields(StrictModel):
    title: str = Field(default="", max_length=70)
    description: str = Field(default="", max_length=180)
    canonical_url: str = Field(default="", max_length=500)
    og_title: str = Field(default="", max_length=100)
    og_description: str = Field(default="", max_length=220)
    og_image: str = Field(default="", max_length=500)
    robots_index: bool = True
    sitemap: bool = True

    _safe_canonical = field_validator("canonical_url")(
        classmethod(lambda cls, value: validate_safe_url(value))
    )
    _safe_image = field_validator("og_image")(
        classmethod(lambda cls, value: validate_safe_url(value))
    )


class ContentButton(StrictModel):
    label: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=1, max_length=500)
    style: Literal["primary", "secondary"] = "primary"

    _safe_url = field_validator("url")(classmethod(lambda cls, value: validate_safe_url(value)))


class ContentElementOverride(StrictModel):
    text: str | None = Field(default=None, max_length=5000)
    href: str | None = Field(default=None, max_length=2048)
    hidden: bool = False

    @field_validator("text")
    @classmethod
    def safe_text(cls, value: str | None) -> str | None:
        return reject_unsafe_markup(value) if value is not None else None

    @field_validator("href")
    @classmethod
    def safe_href(cls, value: str | None) -> str | None:
        return validate_safe_url(value) if value is not None else None


def validate_element_override_keys(
    value: dict[str, ContentElementOverride] | None,
) -> dict[str, ContentElementOverride] | None:
    if value is None:
        return None
    invalid = [key for key in value if not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,119}", key)]
    if invalid:
        raise ValueError("Invalid element override key")
    return value


class ContentBlockInput(StrictModel):
    block_type: BlockType
    content: dict[str, Any] = Field(default_factory=dict)
    is_visible: bool = True

    @field_validator("content")
    @classmethod
    def safe_content(cls, content: dict[str, Any]) -> dict[str, Any]:
        if len(str(content)) > 100_000:
            raise ValueError("Block content is too large")
        def clean_value(key: str, value: Any, depth: int = 0) -> Any:
            if depth > 3:
                raise ValueError("Block content nesting is too deep")
            if isinstance(value, str):
                text = reject_unsafe_markup(value)
                return validate_safe_url(text) if key in {"url", "href", "image_url", "video_url", "target_url"} else text
            if isinstance(value, (bool, int, float)) or value is None:
                return value
            if isinstance(value, list) and len(value) <= 50:
                return [clean_value(key, item, depth + 1) for item in value]
            if isinstance(value, dict) and len(value) <= 30:
                return {str(child_key): clean_value(str(child_key), child_value, depth + 1) for child_key, child_value in value.items()}
            raise ValueError(f"Unsupported value for {key}")

        safe: dict[str, Any] = {}
        for key, value in content.items():
            if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key):
                raise ValueError("Invalid block field")
            safe[key] = clean_value(key, value)
        return safe


class ContentBlockUpdate(StrictModel):
    block_type: BlockType | None = None
    content: dict[str, Any] | None = None
    is_visible: bool | None = None
    expected_page_version: int = Field(ge=1)

    @field_validator("content")
    @classmethod
    def safe_content(cls, content: dict[str, Any] | None) -> dict[str, Any] | None:
        if content is None:
            return None
        return ContentBlockInput(block_type="paragraph", content=content).content


class CmsDraftBlock(StrictModel):
    id: str | None = Field(default=None, min_length=1, max_length=64)
    block_type: BlockType
    content: dict[str, Any] = Field(default_factory=dict)
    is_visible: bool = True

    @field_validator("content")
    @classmethod
    def safe_content(cls, content: dict[str, Any]) -> dict[str, Any]:
        return ContentBlockInput(block_type="paragraph", content=content).content


class BlockOrderUpdate(StrictModel):
    block_ids: list[str] = Field(min_length=1, max_length=200)
    expected_page_version: int = Field(ge=1)


class ContentPageCreate(StrictModel):
    page_key: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,63}$")
    title: str = Field(min_length=1, max_length=160)
    slug: str = Field(pattern=r"^/?[a-z0-9][a-z0-9/_-]{0,158}$")
    hero_heading: str = Field(default="", max_length=200)
    hero_description: str = Field(default="", max_length=2000)
    buttons: list[ContentButton] = Field(default_factory=list, max_length=8)
    element_overrides: dict[str, "ContentElementOverride"] = Field(default_factory=dict, max_length=500)
    seo: SeoFields = Field(default_factory=SeoFields)

    @field_validator("slug")
    @classmethod
    def normalize_slug(cls, value: str) -> str:
        value = value.strip("/")
        return value or "home"

    _safe_heading = field_validator("hero_heading", "hero_description")(
        classmethod(lambda cls, value: reject_unsafe_markup(value))
    )
    _safe_element_keys = field_validator("element_overrides")(
        classmethod(lambda cls, value: validate_element_override_keys(value))
    )


class ContentPageUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=160)
    slug: str | None = Field(default=None, pattern=r"^/?[a-z0-9][a-z0-9/_-]{0,158}$")
    hero_heading: str | None = Field(default=None, max_length=200)
    hero_description: str | None = Field(default=None, max_length=2000)
    buttons: list[ContentButton] | None = Field(default=None, max_length=8)
    element_overrides: dict[str, "ContentElementOverride"] | None = Field(default=None, max_length=500)
    seo: SeoFields | None = None

    @field_validator("slug")
    @classmethod
    def normalize_slug(cls, value: str | None) -> str | None:
        return value.strip("/") or "home" if value is not None else None

    @field_validator("hero_heading", "hero_description")
    @classmethod
    def safe_text(cls, value: str | None) -> str | None:
        return reject_unsafe_markup(value) if value is not None else None

    _safe_element_keys = field_validator("element_overrides")(
        classmethod(lambda cls, value: validate_element_override_keys(value))
    )


class CmsDraftUpdate(StrictModel):
    schema_version: Literal[1] = 1
    page_id: str = Field(min_length=1, max_length=64)
    expected_version: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=160)
    slug: str = Field(pattern=r"^/?[a-z0-9][a-z0-9/_-]{0,158}$")
    hero_heading: str = Field(default="", max_length=200)
    hero_description: str = Field(default="", max_length=2000)
    buttons: list[ContentButton] = Field(default_factory=list, max_length=8)
    element_overrides: dict[str, ContentElementOverride] = Field(default_factory=dict, max_length=500)
    seo: SeoFields = Field(default_factory=SeoFields)
    blocks: list[CmsDraftBlock] = Field(default_factory=list, max_length=200)

    @field_validator("slug")
    @classmethod
    def normalize_slug(cls, value: str) -> str:
        value = value.strip("/")
        return value or "home"

    _safe_text = field_validator("hero_heading", "hero_description")(
        classmethod(lambda cls, value: reject_unsafe_markup(value))
    )
    _safe_element_keys = field_validator("element_overrides")(
        classmethod(lambda cls, value: validate_element_override_keys(value))
    )

    @model_validator(mode="after")
    def unique_block_ids(self):
        ids = [block.id for block in self.blocks if block.id is not None]
        if len(ids) != len(set(ids)):
            raise ValueError("Draft block IDs must be unique")
        return self


class PublishRequest(StrictModel):
    expected_version: int = Field(ge=1)
    change_summary: str = Field(default="", max_length=255)
    scheduled_at: datetime | None = None

    _normalize_time = field_validator("scheduled_at")(classmethod(lambda cls, value: utc_naive(value)))


class RestoreRevisionRequest(StrictModel):
    expected_version: int = Field(ge=1)
    change_summary: str = Field(default="Restored previous revision", max_length=255)


class TextEntryUpdate(StrictModel):
    value: str = Field(max_length=5000)
    expected_version: int = Field(ge=1)

    _safe_value = field_validator("value")(classmethod(lambda cls, value: reject_unsafe_markup(value)))


class TextPublishRequest(StrictModel):
    expected_version: int = Field(ge=1)
    change_summary: str = Field(default="Published content", max_length=255)


class FaqCreate(StrictModel):
    question: str = Field(min_length=3, max_length=300)
    answer: str = Field(min_length=1, max_length=10000)
    category: str = Field(default="General", min_length=1, max_length=80)
    enabled: bool = True
    position: int = Field(default=0, ge=0)

    _safe_text = field_validator("question", "answer", "category")(
        classmethod(lambda cls, value: reject_unsafe_markup(value))
    )


class FaqUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    question: str | None = Field(default=None, min_length=3, max_length=300)
    answer: str | None = Field(default=None, min_length=1, max_length=10000)
    category: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    position: int | None = Field(default=None, ge=0)

    @field_validator("question", "answer", "category")
    @classmethod
    def safe_text(cls, value: str | None) -> str | None:
        return reject_unsafe_markup(value) if value is not None else None


class AnnouncementCreate(StrictModel):
    title: str = Field(min_length=1, max_length=160)
    message: str = Field(min_length=1, max_length=2000)
    action_text: str = Field(default="", max_length=80)
    target_url: str = Field(default="", max_length=500)
    start_at: datetime | None = None
    end_at: datetime | None = None
    targets: Literal["website", "android", "both"] = "both"
    audience: Literal["all", "free", "paid", "admin"] = "all"
    dismissible: bool = True

    _safe_text = field_validator("title", "message", "action_text")(
        classmethod(lambda cls, value: reject_unsafe_markup(value))
    )
    _safe_url = field_validator("target_url")(classmethod(lambda cls, value: validate_safe_url(value)))
    _normalize_times = field_validator("start_at", "end_at")(classmethod(lambda cls, value: utc_naive(value)))

    @model_validator(mode="after")
    def valid_window(self):
        if self.start_at and self.end_at and self.end_at <= self.start_at:
            raise ValueError("End time must be after start time")
        return self


class AnnouncementUpdate(AnnouncementCreate):
    expected_version: int = Field(ge=1)


class MediaMetadataUpdate(StrictModel):
    alt_text: str = Field(default="", max_length=300)
    caption: str = Field(default="", max_length=500)

    _safe_text = field_validator("alt_text", "caption")(
        classmethod(lambda cls, value: reject_unsafe_markup(value))
    )
