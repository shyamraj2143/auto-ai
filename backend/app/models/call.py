import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class UserCallSettings(Base):
    __tablename__ = "user_call_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False
    )
    is_discoverable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    show_online_status: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    show_last_seen: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    allow_audio_calls: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    allow_video_calls: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    call_permission: Mapped[str] = mapped_column(String(32), default="previous_contacts", nullable=False)
    silence_unknown_callers: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    call_notification_sound: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    vibration: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    data_saving_mode: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    user = relationship("User", back_populates="call_settings")


class UserDevice(Base):
    __tablename__ = "user_devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_user_devices_user_device"),
        UniqueConstraint("fcm_token", name="uq_user_devices_fcm_token"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    device_id: Mapped[str] = mapped_column(String(128), nullable=False)
    platform: Mapped[str] = mapped_column(String(32), default="web", index=True, nullable=False)
    fcm_token: Mapped[str] = mapped_column(String(512), nullable=True)
    fcm_token_ciphertext: Mapped[str] = mapped_column(Text, nullable=True)
    fcm_token_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=True)
    app_version: Mapped[str] = mapped_column(String(64), nullable=True)
    app_version_code: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    device_name: Mapped[str] = mapped_column(String(120), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True, nullable=False)
    last_registered_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    user = relationship("User", back_populates="call_devices")


class Call(Base):
    __tablename__ = "calls"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    caller_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    callee_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    call_type: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="initiated", index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    ringing_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    accepted_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    connected_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ended_by: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    end_reason: Mapped[str] = mapped_column(String(32), nullable=True)
    caller_device_id: Mapped[str] = mapped_column(String(128), nullable=True)
    callee_device_id: Mapped[str] = mapped_column(String(128), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class BlockedUser(Base):
    __tablename__ = "blocked_users"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_user_id", name="uq_blocked_users_pair"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    blocker_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    blocked_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class CallReport(Base):
    __tablename__ = "call_reports"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    reporter_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    reported_user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    call_id: Mapped[str] = mapped_column(String(36), ForeignKey("calls.id", ondelete="SET NULL"), nullable=True)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    details: Mapped[str] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
