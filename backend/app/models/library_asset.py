import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.utils.datetime import utc_now


class LibraryAsset(Base):
    __tablename__ = "library_assets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(160), nullable=False)
    file_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    storage_url: Mapped[str] = mapped_column(String(1000), nullable=True)
    thumbnail_url: Mapped[str] = mapped_column(String(1000), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="upload", nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    upload_status: Mapped[str] = mapped_column(String(32), default="ready", nullable=False)
    extracted_text: Mapped[str] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=True)
