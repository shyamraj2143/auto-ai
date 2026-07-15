import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class UserDeviceActivity(Base):
    __tablename__ = "user_device_activities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    device_id: Mapped[str] = mapped_column(String(128), index=True, nullable=True)
    device_type: Mapped[str] = mapped_column(String(16), default="mobile", index=True, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    battery: Mapped[int] = mapped_column(Integer, nullable=True)
    screen_on: Mapped[bool] = mapped_column(Boolean, nullable=True)
    current_app: Mapped[str] = mapped_column(String(255), nullable=True)
    foreground_app_name: Mapped[str] = mapped_column(String(255), nullable=True)
    foreground_package_name: Mapped[str] = mapped_column(String(255), nullable=True)
    activity_type: Mapped[str] = mapped_column(String(64), nullable=True)
    latitude: Mapped[float] = mapped_column(Float, nullable=True)
    longitude: Mapped[float] = mapped_column(Float, nullable=True)
    network: Mapped[str] = mapped_column(String(80), nullable=True)
    storage_total: Mapped[str] = mapped_column(String(80), nullable=True)
    storage_used: Mapped[str] = mapped_column(String(80), nullable=True)
    storage_free: Mapped[str] = mapped_column(String(80), nullable=True)
    ram_total: Mapped[str] = mapped_column(String(80), nullable=True)
    ram_used: Mapped[str] = mapped_column(String(80), nullable=True)
    ram_usage: Mapped[str] = mapped_column(String(80), nullable=True)
    device_model: Mapped[str] = mapped_column(String(120), nullable=True)
    os_version: Mapped[str] = mapped_column(String(80), nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="app_internal", nullable=False)
    permission_granted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User")
