from datetime import datetime
import uuid

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class ApkRelease(Base):
    __tablename__ = "apk_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    version_code: Mapped[int] = mapped_column(Integer, unique=True, index=True, nullable=False)
    version_name: Mapped[str] = mapped_column(String(40), unique=True, index=True, nullable=False)
    apk_url: Mapped[str] = mapped_column(String(500), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0)
    release_date: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    force_update: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    changelog: Mapped[str] = mapped_column(Text, default="")
    download_count: Mapped[int] = mapped_column(Integer, default=0)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    min_android_version: Mapped[str] = mapped_column(String(40), default="Android 7.0")
    release_notes: Mapped[list] = mapped_column(JSON, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class ApkDownload(Base):
    __tablename__ = "apk_downloads"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    release_id: Mapped[str] = mapped_column(
        ForeignKey("apk_versions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    ip_address: Mapped[str] = mapped_column(String(80), default="unknown")
    user_agent: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(24), default="completed")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
