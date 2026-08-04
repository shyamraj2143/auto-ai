from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel, Field

AuthorityLevel = Literal["SUGGEST_ONLY", "PREPARE_AND_ASK", "EXECUTE_AFTER_CONFIRMATION", "EXECUTE_AND_REPORT", "BLOCKED"]
PolicyEffect = Literal["ALLOW", "DENY", "REQUIRE_CONFIRMATION", "REQUIRE_BIOMETRIC", "TRANSFORM"]

class PolicyCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120); description: str = Field(default="", max_length=1000); domain: str = Field(min_length=2, max_length=48)
    priority: int = Field(default=100, ge=0, le=10000); conditions: dict[str, Any] = Field(default_factory=dict); effect: PolicyEffect; enabled: bool = True

class PolicyUpdate(PolicyCreate):
    version: int = Field(ge=1)

class PolicyEvaluate(BaseModel):
    domain: str = Field(min_length=2, max_length=48); action_type: str = Field(min_length=2, max_length=80); context: dict[str, Any] = Field(default_factory=dict)

class LeaseCreate(BaseModel):
    capability: str = Field(min_length=2, max_length=64); purpose: str = Field(min_length=3, max_length=240); fields: list[str] = Field(default_factory=list, max_length=30)
    expires_at: datetime; os_permission_granted: bool

class LeaseRenew(BaseModel): expires_at: datetime

class AuthorityUpdate(BaseModel): level: AuthorityLevel

class EmergencyPauseUpdate(BaseModel):
    active: bool
    reason: str = Field(default="User requested pause", min_length=3, max_length=240)
    expires_at: datetime | None = None

class CommitmentCreate(BaseModel):
    deliverable: str = Field(min_length=2, max_length=300); owner: str = Field(min_length=1, max_length=120); due_at: datetime; estimated_minutes: int = Field(default=60, ge=5, le=10080)

class CommitmentTransition(BaseModel):
    action: Literal["accept", "reject", "start", "submit_evidence", "verify", "cancel", "renegotiate"]
    version: int = Field(ge=1); evidence: dict[str, Any] = Field(default_factory=dict); due_at: datetime | None = None; acknowledge_conflicts: bool = False

class GraphNodeCreate(BaseModel):
    node_type: Literal["commitment", "task", "deadline", "alarm", "contact", "document", "receipt", "calendar_event", "bill"]
    label: str = Field(min_length=2, max_length=240); details: dict[str, Any] = Field(default_factory=dict)
class GraphEdgeCreate(BaseModel):
    from_node_id: str; to_node_id: str; edge_type: Literal["depends_on", "blocks", "enables", "due_before", "requires_resource", "assigned_to", "evidenced_by", "conflicts_with", "affects", "recovered_by"]
