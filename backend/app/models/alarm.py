import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserAlarm(Base):
    __tablename__ = "user_alarms"
    __table_args__ = (
        Index("ix_user_alarms_user_schedule", "user_id", "enabled", "scheduled_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    timezone: Mapped[str] = mapped_column(String(80), default="UTC", nullable=False)
    language: Mapped[str] = mapped_column(String(24), default="hinglish-IN", nullable=False)
    voice_style: Mapped[str] = mapped_column(String(24), default="warm", nullable=False)
    ringtone: Mapped[str] = mapped_column(String(24), default="system", nullable=False)
    assistant_message: Mapped[str] = mapped_column(Text, nullable=False)
    ai_model: Mapped[str] = mapped_column(String(120), nullable=False)
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="scheduled", index=True, nullable=False)
    snooze_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    last_triggered_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
