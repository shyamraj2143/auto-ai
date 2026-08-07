from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, JSON, String, Text, UniqueConstraint
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


class SevaWorkOrder(Base):
    """Human-assistance work order attached to an existing ServiceTask.

    This table never stores authentication secrets. Employees receive only the
    user-approved field/document scope recorded by the linked HumanHandoff.
    """

    __tablename__ = "seva_work_orders"
    __table_args__ = (
        UniqueConstraint("task_id", name="uq_seva_work_order_task"),
        Index("ix_seva_work_order_status_updated", "status", "updated_at"),
        Index("ix_seva_work_order_employee_status", "assigned_employee_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    handoff_id: Mapped[str] = mapped_column(
        ForeignKey("service_human_handoffs.id", ondelete="CASCADE"), unique=True, index=True
    )
    assigned_employee_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(32), default="QUEUED", index=True)
    priority: Mapped[str] = mapped_column(String(16), default="NORMAL")
    request_summary: Mapped[str] = mapped_column(Text, default="")
    user_consent_scope: Mapped[dict] = mapped_column(JSON, default=dict)
    employee_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class SevaRequirementRequest(Base):
    """Additional information/document/protected-action requested by an employee."""

    __tablename__ = "seva_requirement_requests"
    __table_args__ = (
        Index("ix_seva_requirement_work_status", "work_order_id", "status"),
        Index("ix_seva_requirement_task_requested", "task_id", "requested_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(
        ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[str] = mapped_column(
        ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    employee_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    field_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    label: Mapped[str] = mapped_column(String(180))
    instructions: Mapped[str] = mapped_column(Text, default="")
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    protected_action: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(32), default="REQUESTED", index=True)
    response_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    response_document_id: Mapped[str | None] = mapped_column(
        ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    user_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SevaDeliverable(Base):
    """Final receipt/application PDF or supporting deliverable uploaded by an employee."""

    __tablename__ = "seva_deliverables"
    __table_args__ = (Index("ix_seva_deliverable_work_created", "work_order_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(
        ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[str] = mapped_column(
        ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    employee_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    document_id: Mapped[str] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(48), default="APPLICATION_RECEIPT")
    label: Mapped[str] = mapped_column(String(180), default="Application receipt")
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    verified_by_employee: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
