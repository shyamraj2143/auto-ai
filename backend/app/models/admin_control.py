import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class UserSubscription(Base):
    __tablename__ = "user_subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    plan: Mapped[str] = mapped_column(String(32), default="free", index=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    payment_status: Mapped[str] = mapped_column(String(32), default="free", nullable=False)
    razorpay_customer_id: Mapped[str] = mapped_column(String(120), nullable=True)
    razorpay_payment_id: Mapped[str] = mapped_column(String(120), nullable=True)
    stripe_customer_id: Mapped[str] = mapped_column(String(120), nullable=True)
    stripe_payment_id: Mapped[str] = mapped_column(String(120), nullable=True)
    token_limit_monthly: Mapped[int] = mapped_column(Integer, default=10000, nullable=False)
    tokens_used_monthly: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    token_balance: Mapped[int] = mapped_column(Integer, default=10000, nullable=False)
    bonus_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    daily_message_limit: Mapped[int] = mapped_column(Integer, default=25, nullable=False)
    messages_used_today: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    plan_name: Mapped[str] = mapped_column(String(64), default="Free", nullable=False)
    quota_updated_by: Mapped[str] = mapped_column(String(36), nullable=True)
    quota_updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    token_usage_month: Mapped[str] = mapped_column(String(7), default="", nullable=False)
    messages_used_date: Mapped[str] = mapped_column(String(10), default="", nullable=False)
    auto_renewal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_lifetime: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    suspended_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    suspended_by: Mapped[str] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="subscription")


class UsageLog(Base):
    __tablename__ = "usage_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True)
    provider: Mapped[str] = mapped_column(String(32), default="unknown", index=True, nullable=False)
    model: Mapped[str] = mapped_column(String(160), nullable=False)
    endpoint: Mapped[str] = mapped_column(String(120), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    request_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    user = relationship("User", back_populates="usage_logs")


class FeatureFlag(Base):
    __tablename__ = "feature_flags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    key: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    scope: Mapped[str] = mapped_column(String(16), default="global", index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    description: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="feature_flags")


class PlanLimit(Base):
    __tablename__ = "plan_limits"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    plan: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False)
    daily_prompt_limit: Mapped[int] = mapped_column(Integer, default=100)
    monthly_prompt_limit: Mapped[int] = mapped_column(Integer, default=1000)
    daily_token_limit: Mapped[int] = mapped_column(Integer, default=50000)
    monthly_token_limit: Mapped[int] = mapped_column(Integer, default=500000)
    max_models: Mapped[int] = mapped_column(Integer, default=3)
    allow_deep_research: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_multi_model: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_web_search: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PaymentRecord(Base):
    __tablename__ = "payment_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True, nullable=True)
    provider: Mapped[str] = mapped_column(String(32), default="manual", index=True, nullable=False)
    customer_id: Mapped[str] = mapped_column(String(120), nullable=True)
    payment_id: Mapped[str] = mapped_column(String(120), nullable=True)
    subscription_id: Mapped[str] = mapped_column(String(120), nullable=True)
    plan: Mapped[str] = mapped_column(String(32), default="free", nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, default=0)
    currency: Mapped[str] = mapped_column(String(12), default="INR", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="unknown", index=True, nullable=False)
    raw_metadata: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    user = relationship("User", back_populates="payment_records")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    actor_user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=True)
    target_user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=True)
    action: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    audit_metadata: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
