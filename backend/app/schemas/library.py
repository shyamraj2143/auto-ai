from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_serializer

from app.utils.datetime import to_rfc3339_utc


class LibraryAssetRead(BaseModel):
    id: str
    original_name: str
    display_name: str
    mime_type: str
    file_type: str
    file_size: int
    source: str
    checksum: str
    upload_status: str
    metadata_json: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    last_used_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_serializer("created_at", "updated_at", "last_used_at")
    def serialize_dates(self, value: datetime | None) -> str | None:
        return to_rfc3339_utc(value) if value else None


class LibraryAssetPage(BaseModel):
    items: list[LibraryAssetRead]
    page: int
    page_size: int
    total: int
    has_more: bool


class LibraryAssetUpdate(BaseModel):
    display_name: str = Field(min_length=1, max_length=255)


class LibraryAttachRequest(BaseModel):
    chat_id: str | None = None


class LibraryAttachmentRead(BaseModel):
    asset_id: str
    document_id: str | None = None
    type: Literal["image", "file"]
    filename: str
    mime_type: str
    file_size: int
    url: str
