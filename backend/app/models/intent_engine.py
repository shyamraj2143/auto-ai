import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _id() -> str:
    return str(uuid.uuid4())


class IntentEvent(Base):
    __tablename__ = "intent_events"
    __table_args__ = (Index("ix_intent_event_owner_chat", "user_id", "chat_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    chat_id: Mapped[str] = mapped_column(String(36), ForeignKey("chats.id", ondelete="CASCADE"), nullable=True)
    input_hash: Mapped[str] = mapped_column(String(64))
    classification: Mapped[dict] = mapped_column(JSON)
    policy_decision: Mapped[dict] = mapped_column(JSON)
    interpreter_version: Mapped[str] = mapped_column(String(32), default="intent-v1")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class WorkflowDefinition(Base):
    __tablename__ = "intent_workflow_definitions"
    __table_args__ = (UniqueConstraint("user_id", "name", "version", name="uq_intent_workflow_version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    version: Mapped[int] = mapped_column(Integer, default=1)
    definition: Mapped[dict] = mapped_column(JSON)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    validation_report: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WorkflowRun(Base):
    __tablename__ = "intent_workflow_runs"
    __table_args__ = (Index("ix_intent_run_owner_state", "user_id", "state", "updated_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    chat_id: Mapped[str] = mapped_column(String(36), ForeignKey("chats.id", ondelete="SET NULL"), nullable=True)
    definition_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_workflow_definitions.id", ondelete="SET NULL"), nullable=True)
    intent_event_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_events.id", ondelete="CASCADE"))
    state: Mapped[str] = mapped_column(String(48), default="RECEIVED")
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    failure: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)


class RequirementRecord(Base):
    __tablename__ = "intent_requirements"
    __table_args__ = (UniqueConstraint("run_id", "key", name="uq_intent_requirement_run_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_workflow_runs.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(100))
    kind: Mapped[str] = mapped_column(String(32), default="information")
    state: Mapped[str] = mapped_column(String(40), default="UNKNOWN")
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SecureChallenge(Base):
    __tablename__ = "intent_secure_challenges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_workflow_runs.id", ondelete="CASCADE"), index=True)
    destination_hash: Mapped[str] = mapped_column(String(64))
    secret_hash: Mapped[str] = mapped_column(String(128), nullable=True)
    kind: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(24), default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    consumed_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ActionReceipt(Base):
    __tablename__ = "intent_action_receipts"
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key", name="uq_intent_receipt_idempotency"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_workflow_runs.id", ondelete="CASCADE"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(100))
    tool_name: Mapped[str] = mapped_column(String(100))
    interpreted_request: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32))
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    audit: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PreferenceSuggestion(Base):
    __tablename__ = "intent_preference_suggestions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(100))
    proposed_value: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(24), default="pending")
    evidence_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class IntentFeedbackEvent(Base):
    __tablename__ = "intent_feedback_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    intent_event_id: Mapped[str] = mapped_column(String(36), ForeignKey("intent_events.id", ondelete="SET NULL"), nullable=True)
    event_type: Mapped[str] = mapped_column(String(48))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    evaluation_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
