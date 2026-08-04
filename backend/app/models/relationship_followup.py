import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def uuid4_string() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class RelationshipContact(Base):
    __tablename__ = "relationship_contacts"
    __table_args__ = (
        UniqueConstraint("user_id", "client_request_id", name="uq_relationship_contacts_user_request"),
        Index("ix_relationship_contacts_user_status_due", "user_id", "status", "next_followup_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    relationship_type: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    preferred_channel: Mapped[str] = mapped_column(String(24), nullable=True)
    contact_value_ciphertext: Mapped[str] = mapped_column(Text, nullable=True)
    last_contacted_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    cadence: Mapped[str] = mapped_column(String(24), nullable=False)
    followup_interval_days: Mapped[int] = mapped_column(Integer, nullable=False)
    next_followup_at: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    preferred_reminder_time: Mapped[str] = mapped_column(String(5), nullable=False)
    timezone: Mapped[str] = mapped_column(String(80), nullable=False)
    priority: Mapped[str] = mapped_column(String(16), index=True, nullable=False)
    notes_ciphertext: Mapped[str] = mapped_column(Text, nullable=True)
    preferred_language: Mapped[str] = mapped_column(String(8), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    client_request_id: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class RelationshipFollowupEvent(Base):
    __tablename__ = "relationship_followup_events"
    __table_args__ = (
        UniqueConstraint("user_id", "deduplication_key", name="uq_relationship_followup_event_dedupe"),
        Index("ix_relationship_followup_events_due", "status", "scheduled_at", "next_attempt_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    relationship_contact_id: Mapped[str] = mapped_column(String(36), ForeignKey("relationship_contacts.id", ondelete="CASCADE"), index=True, nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True, nullable=False)
    completed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    snoozed_until: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    deduplication_key: Mapped[str] = mapped_column(String(160), nullable=False)
    notification_event_id: Mapped[str] = mapped_column(String(96), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    claimed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    claim_token: Mapped[str] = mapped_column(String(36), index=True, nullable=True)
    sent_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    failure_code: Mapped[str] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class RelationshipInteraction(Base):
    __tablename__ = "relationship_interactions"
    __table_args__ = (UniqueConstraint("user_id", "request_id", name="uq_relationship_interactions_user_request"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    relationship_contact_id: Mapped[str] = mapped_column(String(36), ForeignKey("relationship_contacts.id", ondelete="CASCADE"), index=True, nullable=False)
    contacted_at: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    channel: Mapped[str] = mapped_column(String(24), nullable=True)
    note_ciphertext: Mapped[str] = mapped_column(Text, nullable=True)
    request_id: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class RelationshipNotificationPreference(Base):
    __tablename__ = "relationship_notification_preferences"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    detailed_preview: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    permission_state: Mapped[str] = mapped_column(String(24), default="unknown", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class RelationshipDeliveryAttempt(Base):
    __tablename__ = "relationship_delivery_attempts"
    __table_args__ = (UniqueConstraint("event_id", "device_id", "attempt_number", name="uq_relationship_delivery_attempt"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    event_id: Mapped[str] = mapped_column(String(36), ForeignKey("relationship_followup_events.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("user_devices.id", ondelete="CASCADE"), nullable=False)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    failure_code: Mapped[str] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class RelationshipAuditEvent(Base):
    __tablename__ = "relationship_audit_events"
    __table_args__ = (
        UniqueConstraint("user_id", "request_id", "event_type", name="uq_relationship_audit_request_event"),
        Index("ix_relationship_audit_user_created", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_string)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    relationship_contact_id: Mapped[str] = mapped_column(String(36), ForeignKey("relationship_contacts.id", ondelete="SET NULL"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(48), nullable=False)
    request_id: Mapped[str] = mapped_column(String(80), nullable=False)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
