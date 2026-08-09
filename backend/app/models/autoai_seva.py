from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
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
    case_number: Mapped[str | None] = mapped_column(String(32), unique=True, index=True, nullable=True)
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
    department: Mapped[str] = mapped_column(String(100), default="AutoAI Seva Operations", index=True)
    queue_name: Mapped[str] = mapped_column(String(100), default="General", index=True)
    request_summary: Mapped[str] = mapped_column(Text, default="")
    user_consent_scope: Mapped[dict] = mapped_column(JSON, default=dict)
    employee_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_activity: Mapped[str] = mapped_column(String(240), default="Submitted")
    progress_percent: Mapped[int] = mapped_column(Integer, default=0)
    reference_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    official_status: Mapped[str | None] = mapped_column(String(120), nullable=True)
    sla_status: Mapped[str] = mapped_column(String(24), default="ON_TRACK", index=True)
    escalation_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    quality_required: Mapped[bool] = mapped_column(Boolean, default=False)
    quality_status: Mapped[str] = mapped_column(String(24), default="NOT_REQUIRED", index=True)
    reviewer_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class SevaAgentProfile(Base):
    """Admin-managed employee identity and workload policy."""

    __tablename__ = "seva_agent_profiles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    agent_code: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(120))
    work_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    contact_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    specializations: Mapped[list] = mapped_column(JSON, default=list)
    languages: Mapped[list] = mapped_column(JSON, default=list)
    capacity: Mapped[int] = mapped_column(Integer, default=5)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    status: Mapped[str] = mapped_column(String(24), default="ACTIVE", index=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_admin_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    last_assigned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class SevaNotification(Base):
    """Private in-app notification for an application owner or assigned agent."""

    __tablename__ = "seva_notifications"
    __table_args__ = (
        Index("ix_seva_notification_recipient_read", "recipient_user_id", "read_at"),
        Index("ix_seva_notification_work_created", "work_order_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(
        ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True
    )
    recipient_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    event_type: Mapped[str] = mapped_column(String(48), index=True)
    title: Mapped[str] = mapped_column(String(180))
    message: Mapped[str] = mapped_column(Text)
    deep_link: Mapped[str | None] = mapped_column(String(500), nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(160), unique=True, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class SevaAssignment(Base):
    __tablename__ = "seva_assignments"
    __table_args__ = (Index("ix_seva_assignment_work_assigned", "work_order_id", "assigned_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True)
    agent_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    assigned_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    reason: Mapped[str] = mapped_column(String(240), default="Automatic assignment")
    assigned_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_reason: Mapped[str | None] = mapped_column(String(240), nullable=True)


class SevaCaseEvent(Base):
    __tablename__ = "seva_case_events"
    __table_args__ = (
        Index("ix_seva_case_event_work_created", "work_order_id", "created_at"),
        UniqueConstraint("work_order_id", "dedupe_key", name="uq_seva_case_event_dedupe"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String(16), default="USER", index=True)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(180))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    dedupe_key: Mapped[str] = mapped_column(String(160))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


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


class SevaQualityReview(Base):
    """Second-person review record with immutable decision history."""

    __tablename__ = "seva_quality_reviews"
    __table_args__ = (
        Index("ix_seva_quality_review_work_status", "work_order_id", "status"),
        Index("ix_seva_quality_review_reviewer_status", "reviewer_user_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    work_order_id: Mapped[str] = mapped_column(
        ForeignKey("seva_work_orders.id", ondelete="CASCADE"), index=True
    )
    requested_by_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    reviewer_user_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="PENDING", index=True)
    snapshot_version: Mapped[int] = mapped_column(Integer, default=1)
    decision_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
