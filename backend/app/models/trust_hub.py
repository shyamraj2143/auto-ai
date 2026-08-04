import uuid
from datetime import datetime
from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.db.base import Base

class HubPolicyRule(Base):
    __tablename__ = "hub_policy_rules"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120)); description: Mapped[str] = mapped_column(Text, default=""); domain: Mapped[str] = mapped_column(String(48), index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True); priority: Mapped[int] = mapped_column(Integer, default=100)
    conditions: Mapped[dict] = mapped_column(JSON, default=dict); effect: Mapped[str] = mapped_column(String(32))
    version: Mapped[int] = mapped_column(Integer, default=1); source: Mapped[str] = mapped_column(String(24), default="USER")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow); updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HubPolicyEvaluation(Base):
    __tablename__ = "hub_policy_evaluations"; __table_args__ = (Index("ix_hub_policy_eval_user_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    domain: Mapped[str] = mapped_column(String(48)); action_type: Mapped[str] = mapped_column(String(80)); context: Mapped[dict] = mapped_column(JSON)
    decision: Mapped[str] = mapped_column(String(32)); matched_policy_ids: Mapped[list] = mapped_column(JSON, default=list); explanation: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class HubConsentLease(Base):
    __tablename__ = "hub_consent_leases"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    capability: Mapped[str] = mapped_column(String(64)); purpose: Mapped[str] = mapped_column(String(240)); fields: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE"); os_permission_granted: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime); revoked_at: Mapped[datetime] = mapped_column(DateTime, nullable=True); created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class HubAuthoritySetting(Base):
    __tablename__ = "hub_authority_settings"; __table_args__ = (UniqueConstraint("user_id", "domain"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    domain: Mapped[str] = mapped_column(String(48)); level: Mapped[str] = mapped_column(String(32), default="CONFIRM_BEFORE_EXECUTE")
    temporary_until: Mapped[datetime] = mapped_column(DateTime, nullable=True); updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HubEmergencyPause(Base):
    __tablename__ = "hub_emergency_pauses"
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str] = mapped_column(String(240), default="User requested pause")
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    enabled_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HubCommitment(Base):
    __tablename__ = "hub_commitments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    deliverable: Mapped[str] = mapped_column(String(300)); owner: Mapped[str] = mapped_column(String(120)); due_at: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(24), default="DRAFT"); feasibility: Mapped[str] = mapped_column(String(24), default="RISKY"); version: Mapped[int] = mapped_column(Integer, default=1)
    estimated_minutes: Mapped[int] = mapped_column(Integer, default=60); conflict_ids: Mapped[list] = mapped_column(JSON, default=list)
    evidence: Mapped[dict] = mapped_column(JSON, default=dict); recovery_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow); updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HubActionReceipt(Base):
    __tablename__ = "hub_action_receipts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    action_type: Mapped[str] = mapped_column(String(80)); status: Mapped[str] = mapped_column(String(32)); explanation: Mapped[str] = mapped_column(Text)
    evidence_strength: Mapped[str] = mapped_column(String(24), default="WEAK"); request_id: Mapped[str] = mapped_column(String(80), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class HubGraphNode(Base):
    __tablename__ = "hub_graph_nodes"; __table_args__ = (UniqueConstraint("user_id", "source_type", "source_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    node_type: Mapped[str] = mapped_column(String(32), index=True); label: Mapped[str] = mapped_column(String(240)); details: Mapped[dict] = mapped_column(JSON, default=dict)
    source_type: Mapped[str] = mapped_column(String(32)); source_id: Mapped[str] = mapped_column(String(80)); archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow); updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class HubGraphEdge(Base):
    __tablename__ = "hub_graph_edges"; __table_args__ = (UniqueConstraint("user_id", "from_node_id", "to_node_id", "edge_type"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    from_node_id: Mapped[str] = mapped_column(String(36), ForeignKey("hub_graph_nodes.id", ondelete="CASCADE"), index=True); to_node_id: Mapped[str] = mapped_column(String(36), ForeignKey("hub_graph_nodes.id", ondelete="CASCADE"), index=True)
    edge_type: Mapped[str] = mapped_column(String(32)); confidence: Mapped[int] = mapped_column(Integer, default=100); source: Mapped[str] = mapped_column(String(32), default="USER"); created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class HubConstraint(Base):
    __tablename__ = "hub_constraints"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40), index=True); source: Mapped[str] = mapped_column(String(32)); value: Mapped[dict] = mapped_column(JSON)
    hard: Mapped[bool] = mapped_column(Boolean, default=False); confidence: Mapped[int] = mapped_column(Integer, default=100)
    observed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow); expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True)

class TrustActionRequest(Base):
    __tablename__ = "trust_action_requests"; __table_args__ = (UniqueConstraint("user_id", "idempotency_key"), Index("ix_trust_action_user_status", "user_id", "status"))
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    domain: Mapped[str] = mapped_column(String(48)); action_type: Mapped[str] = mapped_column(String(80)); resource_id: Mapped[str] = mapped_column(String(80), nullable=True)
    normalized_payload: Mapped[dict] = mapped_column(JSON); risk_level: Mapped[str] = mapped_column(String(16)); status: Mapped[str] = mapped_column(String(32), default="PROPOSED")
    decision_json: Mapped[dict] = mapped_column(JSON, default=dict); idempotency_key: Mapped[str] = mapped_column(String(80)); confirmation_token: Mapped[str] = mapped_column(String(64), nullable=True)
    confirmation_expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=True); created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow); updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class TrustAuditEvent(Base):
    __tablename__ = "trust_audit_events"; __table_args__ = (Index("ix_trust_audit_user_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    action_request_id: Mapped[str] = mapped_column(String(36), ForeignKey("trust_action_requests.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(48)); details: Mapped[dict] = mapped_column(JSON, default=dict); previous_hash: Mapped[str] = mapped_column(String(64), default=""); event_hash: Mapped[str] = mapped_column(String(64)); created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
