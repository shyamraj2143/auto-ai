import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _id() -> str:
    return str(uuid.uuid4())


class ServiceDefinition(Base):
    __tablename__ = "service_definitions"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    provider: Mapped[str] = mapped_column(String(180), nullable=False)
    country: Mapped[str] = mapped_column(String(2), default="IN")
    region: Mapped[str | None] = mapped_column(String(100), nullable=True)
    category: Mapped[str] = mapped_column(String(60), index=True)
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    execution_modes: Mapped[list] = mapped_column(JSON, default=list)
    requirements: Mapped[list] = mapped_column(JSON, default=list)
    required_documents: Mapped[list] = mapped_column(JSON, default=list)
    eligibility_rules: Mapped[list] = mapped_column(JSON, default=list)
    fee: Mapped[dict] = mapped_column(JSON, default=dict)
    processing_information: Mapped[str] = mapped_column(Text, default="")
    authentication_type: Mapped[str] = mapped_column(String(48), default="none")
    tracking_method: Mapped[str] = mapped_column(String(48), default="none")
    support_contact: Mapped[dict] = mapped_column(JSON, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServicePortal(Base):
    __tablename__ = "service_portals"
    __table_args__ = (UniqueConstraint("service_id", "origin", name="uq_service_portal_origin"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    service_id: Mapped[str] = mapped_column(ForeignKey("service_definitions.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(180))
    origin: Mapped[str] = mapped_column(String(500))
    entry_url: Mapped[str] = mapped_column(String(1000))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    allowed_redirect_origins: Mapped[list] = mapped_column(JSON, default=list)
    terms_note: Mapped[str] = mapped_column(Text, default="")
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PortalAdapterRecord(Base):
    __tablename__ = "service_portal_adapters"
    __table_args__ = (UniqueConstraint("service_id", "adapter_key", name="uq_service_adapter_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    service_id: Mapped[str] = mapped_column(ForeignKey("service_definitions.id", ondelete="CASCADE"), index=True)
    adapter_key: Mapped[str] = mapped_column(String(80))
    adapter_type: Mapped[str] = mapped_column(String(48))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    configuration: Mapped[dict] = mapped_column(JSON, default=dict)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=30)
    retry_policy: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServiceTask(Base):
    __tablename__ = "service_tasks"
    __table_args__ = (
        Index("ix_service_task_owner_state_updated", "user_id", "state", "updated_at"),
        UniqueConstraint("user_id", "client_request_id", name="uq_service_task_client_request"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    chat_id: Mapped[str] = mapped_column(String(36), ForeignKey("chats.id", ondelete="SET NULL"), nullable=True, index=True)
    service_id: Mapped[str] = mapped_column(ForeignKey("service_definitions.id", ondelete="RESTRICT"), index=True)
    portal_id: Mapped[str | None] = mapped_column(ForeignKey("service_portals.id", ondelete="SET NULL"), nullable=True)
    adapter_id: Mapped[str] = mapped_column(ForeignKey("service_portal_adapters.id", ondelete="RESTRICT"))
    client_request_id: Mapped[str] = mapped_column(String(120))
    original_request: Mapped[str] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(String(35), default="en-IN")
    timezone: Mapped[str] = mapped_column(String(100), default="UTC")
    execution_mode: Mapped[str] = mapped_column(String(40), default="PREPARE")
    state: Mapped[str] = mapped_column(String(64), default="CREATED")
    current_card: Mapped[str] = mapped_column(String(48), default="service_plan")
    progress_percent: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    failure_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    failure_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    paused_from_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServiceTaskStep(Base):
    __tablename__ = "service_task_steps"
    __table_args__ = (UniqueConstraint("task_id", "position", name="uq_service_task_step_position"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(48))
    title: Mapped[str] = mapped_column(String(180))
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class TaskStateTransition(Base):
    __tablename__ = "service_task_transitions"
    __table_args__ = (Index("ix_service_transition_task_created", "task_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    actor: Mapped[str] = mapped_column(String(48))
    source: Mapped[str] = mapped_column(String(80))
    previous_state: Mapped[str] = mapped_column(String(64))
    new_state: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str] = mapped_column(Text)
    request_id: Mapped[str] = mapped_column(String(120), index=True)
    evidence_reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserDataRequest(Base):
    __tablename__ = "service_user_data_requests"
    __table_args__ = (UniqueConstraint("task_id", "request_key", name="uq_service_data_request_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    request_key: Mapped[str] = mapped_column(String(100))
    title: Mapped[str] = mapped_column(String(180))
    description: Mapped[str] = mapped_column(Text, default="")
    fields: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class UserFieldResponse(Base):
    __tablename__ = "service_user_field_responses"
    __table_args__ = (UniqueConstraint("task_id", "field_key", name="uq_service_field_response_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    request_id: Mapped[str] = mapped_column(ForeignKey("service_user_data_requests.id", ondelete="CASCADE"))
    field_key: Mapped[str] = mapped_column(String(100))
    value_json: Mapped[dict] = mapped_column(JSON, default=dict)
    encrypted_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    sensitivity: Mapped[str] = mapped_column(String(32), default="ordinary")
    source: Mapped[str] = mapped_column(String(48), default="user")
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServiceSecureChallenge(Base):
    __tablename__ = "service_secure_challenges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    portal_session_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    kind: Mapped[str] = mapped_column(String(32))
    official_origin: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DocumentRequirement(Base):
    __tablename__ = "service_document_requirements"
    __table_args__ = (UniqueConstraint("task_id", "requirement_key", name="uq_service_document_requirement_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    requirement_key: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(180))
    accepted_mime_types: Mapped[list] = mapped_column(JSON, default=list)
    max_bytes: Mapped[int] = mapped_column(Integer)
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(32), default="MISSING")
    position: Mapped[int] = mapped_column(Integer, default=0)


class ServiceDocumentAsset(Base):
    __tablename__ = "service_document_assets"
    __table_args__ = (UniqueConstraint("task_id", "requirement_id", "sha256", name="uq_service_document_hash"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    requirement_id: Mapped[str] = mapped_column(ForeignKey("service_document_requirements.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    sha256: Mapped[str] = mapped_column(String(64))
    validation_status: Mapped[str] = mapped_column(String(32), default="PENDING")
    detected_type: Mapped[str | None] = mapped_column(String(80), nullable=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    temporary_only: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DocumentAnalysis(Base):
    __tablename__ = "service_document_analyses"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    asset_id: Mapped[str] = mapped_column(ForeignKey("service_document_assets.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    ocr_status: Mapped[str] = mapped_column(String(32), default="NOT_REQUESTED")
    extracted_fields: Mapped[dict] = mapped_column(JSON, default=dict)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_dimensions: Mapped[dict] = mapped_column(JSON, default=dict)
    scanner_result: Mapped[dict] = mapped_column(JSON, default=dict)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class FormDraft(Base):
    __tablename__ = "service_form_drafts"
    __table_args__ = (UniqueConstraint("task_id", name="uq_service_form_draft_task"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="DRAFT")
    version: Mapped[int] = mapped_column(Integer, default=1)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    validated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class FormField(Base):
    __tablename__ = "service_form_fields"
    __table_args__ = (UniqueConstraint("draft_id", "field_key", name="uq_service_form_field_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    draft_id: Mapped[str] = mapped_column(ForeignKey("service_form_drafts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    field_key: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(180))
    value_json: Mapped[dict] = mapped_column(JSON, default=dict)
    encrypted_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    sensitivity: Mapped[str] = mapped_column(String(24), default="ordinary")
    source: Mapped[str] = mapped_column(String(48))
    confidence: Mapped[str] = mapped_column(String(16), default="high")
    user_approved: Mapped[bool] = mapped_column(Boolean, default=False)


class FieldMapping(Base):
    __tablename__ = "service_field_mappings"
    __table_args__ = (UniqueConstraint("service_id", "adapter_field", name="uq_service_field_mapping"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    service_id: Mapped[str] = mapped_column(ForeignKey("service_definitions.id", ondelete="CASCADE"), index=True)
    canonical_field: Mapped[str] = mapped_column(String(100))
    adapter_field: Mapped[str] = mapped_column(String(180))
    transform: Mapped[dict] = mapped_column(JSON, default=dict)


class PortalSession(Base):
    __tablename__ = "service_portal_sessions"
    __table_args__ = (UniqueConstraint("task_id", name="uq_service_portal_session_task"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    portal_id: Mapped[str | None] = mapped_column(ForeignKey("service_portals.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")
    mode: Mapped[str] = mapped_column(String(40))
    current_step: Mapped[str] = mapped_column(String(180), default="Open portal")
    user_action_required: Mapped[str | None] = mapped_column(String(240), nullable=True)
    adapter_state: Mapped[dict] = mapped_column(JSON, default=dict)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class ConsentGrant(Base):
    __tablename__ = "service_consent_grants"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    purpose: Mapped[str] = mapped_column(String(240))
    data_scope: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(24), default="ACTIVE")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PermissionRequest(Base):
    __tablename__ = "service_permission_requests"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    capability: Mapped[str] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(String(240))
    data_accessed: Mapped[list] = mapped_column(JSON, default=list)
    processing_location: Mapped[str] = mapped_column(String(32), default="device")
    retention: Mapped[str] = mapped_column(String(120), default="Only during this action")
    native_status: Mapped[str] = mapped_column(String(40), default="NOT_REQUESTED")
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    prompted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SubmissionConfirmation(Base):
    __tablename__ = "service_submission_confirmations"
    __table_args__ = (UniqueConstraint("task_id", "draft_version", name="uq_service_confirmation_draft"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    draft_version: Mapped[int] = mapped_column(Integer)
    declaration: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="PENDING")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)


class SubmissionAttempt(Base):
    __tablename__ = "service_submission_attempts"
    __table_args__ = (UniqueConstraint("user_id", "idempotency_key", name="uq_service_submission_idempotency"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    confirmation_id: Mapped[str] = mapped_column(ForeignKey("service_submission_confirmations.id", ondelete="RESTRICT"))
    idempotency_key: Mapped[str] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(40), default="DISPATCHING")
    adapter_reference: Mapped[str | None] = mapped_column(String(180), nullable=True)
    safe_error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ServiceActionReceipt(Base):
    __tablename__ = "service_action_receipts"
    __table_args__ = (UniqueConstraint("task_id", name="uq_service_receipt_task"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    attempt_id: Mapped[str] = mapped_column(ForeignKey("service_submission_attempts.id", ondelete="RESTRICT"))
    status: Mapped[str] = mapped_column(String(40))
    application_id: Mapped[str | None] = mapped_column(String(180), nullable=True)
    transaction_id: Mapped[str | None] = mapped_column(String(180), nullable=True)
    fee: Mapped[dict] = mapped_column(JSON, default=dict)
    document_count: Mapped[int] = mapped_column(Integer, default=0)
    portal_origin: Mapped[str | None] = mapped_column(String(500), nullable=True)
    expected_timeline: Mapped[str | None] = mapped_column(String(240), nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ReceiptEvidence(Base):
    __tablename__ = "service_receipt_evidence"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    receipt_id: Mapped[str] = mapped_column(ForeignKey("service_action_receipts.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    evidence_type: Mapped[str] = mapped_column(String(48))
    reference: Mapped[str] = mapped_column(String(500))
    checksum: Mapped[str] = mapped_column(String(64))
    verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verification_details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TrackingSubscription(Base):
    __tablename__ = "service_tracking_subscriptions"
    __table_args__ = (UniqueConstraint("task_id", name="uq_service_tracking_task"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")
    last_known_status: Mapped[str | None] = mapped_column(String(80), nullable=True)
    next_check_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServiceAuditEvent(Base):
    __tablename__ = "service_audit_events"
    __table_args__ = (Index("ix_service_audit_owner_created", "user_id", "created_at"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    previous_hash: Mapped[str] = mapped_column(String(64), default="")
    event_hash: Mapped[str] = mapped_column(String(64))
    request_id: Mapped[str] = mapped_column(String(120), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class HumanHandoff(Base):
    __tablename__ = "service_human_handoffs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_id)
    task_id: Mapped[str] = mapped_column(ForeignKey("service_tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(32), default="PENDING_APPROVAL")
    agent_identity: Mapped[dict] = mapped_column(JSON, default=dict)
    approved_field_keys: Mapped[list] = mapped_column(JSON, default=list)
    approved_document_ids: Mapped[list] = mapped_column(JSON, default=list)
    purpose: Mapped[str] = mapped_column(String(240))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


@event.listens_for(ServiceAuditEvent, "before_update")
@event.listens_for(ServiceAuditEvent, "before_delete")
def _reject_audit_mutation(*_: object) -> None:
    raise RuntimeError("Service audit events are append-only")
