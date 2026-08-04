from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _id() -> str:
    return str(uuid.uuid4())


class ServiceFieldConflict(Base):
    """Persisted, owner-scoped conflict between user data and document candidates.

    Candidate values are stored only in encrypted form. `candidate_summary` contains
    safe labels, sources, and confidence bands suitable for the UI and audit trail.
    """

    __tablename__ = "service_field_conflicts"
    __table_args__ = (
        Index("ix_service_field_conflict_task_state", "task_id", "resolution_state"),
        Index("ix_service_field_conflict_owner_created", "user_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("service_tasks.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    field_key: Mapped[str] = mapped_column(String(100), index=True)
    source_document_id: Mapped[str | None] = mapped_column(
        ForeignKey("service_document_assets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    conflict_type: Mapped[str] = mapped_column(String(48), default="VALUE_MISMATCH")
    candidate_summary: Mapped[dict] = mapped_column(JSON, default=dict)
    encrypted_candidate_values: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolution_state: Mapped[str] = mapped_column(String(32), default="OPEN")
    selected_source: Mapped[str | None] = mapped_column(String(48), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(String(240), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )
