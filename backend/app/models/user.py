import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    mobile: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    username: Mapped[str] = mapped_column(String(48), unique=True, index=True, nullable=True)
    phone_number: Mapped[str] = mapped_column(String(32), nullable=True)
    phone_country_code: Mapped[str] = mapped_column(String(8), nullable=True)
    phone_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    phone_verified_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    picture: Mapped[str] = mapped_column(String(500), nullable=True)
    avatar: Mapped[str] = mapped_column(String(500), nullable=True)
    bio: Mapped[str] = mapped_column(Text, nullable=True)
    profile_visibility: Mapped[str] = mapped_column(String(16), default="public", nullable=False)
    message_permission: Mapped[str] = mapped_column(String(32), default="everyone", nullable=False)
    provider: Mapped[str] = mapped_column(String(32), default="email", index=True, nullable=False)
    google_id: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    role: Mapped[str] = mapped_column(String(32), default="user", index=True, nullable=False)
    subscription_status: Mapped[str] = mapped_column(String(32), default="free", index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    profile_updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)

    chats = relationship("Chat", back_populates="user", cascade="all, delete-orphan")
    documents = relationship("Document", back_populates="user", cascade="all, delete-orphan")
    api_usages = relationship("APIUsage", back_populates="user", cascade="all, delete-orphan")
    usage_logs = relationship("UsageLog", back_populates="user")
    subscription = relationship(
        "UserSubscription",
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
    )
    feature_flags = relationship("FeatureFlag", back_populates="user", cascade="all, delete-orphan")
    payment_records = relationship("PaymentRecord", back_populates="user")
    interaction_profile = relationship(
        "UserInteractionProfile",
        back_populates="user",
        cascade="all, delete-orphan",
        uselist=False,
    )
    memories = relationship("UserMemory", back_populates="user", cascade="all, delete-orphan")
    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")
    password_reset_tokens = relationship("PasswordResetToken", back_populates="user", cascade="all, delete-orphan")
    call_settings = relationship(
        "UserCallSettings", back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    call_devices = relationship("UserDevice", back_populates="user", cascade="all, delete-orphan")
    turn_analyses = relationship(
        "ConversationTurnAnalysis",
        back_populates="user",
        cascade="all, delete-orphan",
    )
