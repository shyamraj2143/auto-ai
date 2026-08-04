import hashlib
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.trust_hub import HubActionReceipt, HubAuthoritySetting, HubCommitment, HubConsentLease, HubEmergencyPause, HubGraphEdge, HubGraphNode, HubPolicyEvaluation, HubPolicyRule, TrustActionRequest, TrustAuditEvent
from app.models.user import User
from app.schemas.trust_hub import AuthorityUpdate, CommitmentCreate, CommitmentTransition, EmergencyPauseUpdate, GraphEdgeCreate, GraphNodeCreate, LeaseCreate, LeaseRenew, PolicyCreate, PolicyEvaluate, PolicyUpdate
from app.services.trust_gateway import GatewayInput, GatewayStatus, authorize_and_execute
from app.services.trust_hub_service import evaluate_policy, lease_active

router = APIRouter(prefix="/hub", tags=["white-space-hub"])
def policy_json(x): return {"id": x.id, "name": x.name, "description": x.description, "domain": x.domain, "priority": x.priority, "conditions": x.conditions, "effect": x.effect, "enabled": x.enabled, "version": x.version, "created_at": x.created_at, "updated_at": x.updated_at}

@router.get("/summary")
def summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    policies = list(db.scalars(select(HubPolicyRule).where(HubPolicyRule.user_id == user.id))); leases = list(db.scalars(select(HubConsentLease).where(HubConsentLease.user_id == user.id))); commitments = list(db.scalars(select(HubCommitment).where(HubCommitment.user_id == user.id))); receipts = list(db.scalars(select(HubActionReceipt).where(HubActionReceipt.user_id == user.id).order_by(HubActionReceipt.created_at.desc()).limit(20)))
    pause = db.get(HubEmergencyPause, user.id); now = datetime.utcnow(); pause_active = bool(pause and pause.active and (not pause.expires_at or pause.expires_at > now))
    blocked = len(list(db.scalars(select(TrustActionRequest).where(TrustActionRequest.user_id == user.id, TrustActionRequest.status == "DENIED"))))
    return {"policy_count": len(policies), "active_leases": sum(lease_active(x) for x in leases), "at_risk_commitments": sum(x.feasibility != "FEASIBLE" for x in commitments), "pending_receipts": sum(x.status not in {"COMPLETED_VERIFIED", "FAILED_TERMINAL", "CANCELLED", "REVERSED"} for x in receipts), "blocked_actions": blocked, "expiring_leases": sum(lease_active(x) and x.expires_at <= now.replace(microsecond=0) + timedelta(days=7) for x in leases), "pause": {"active": pause_active, "reason": pause.reason if pause else None, "expires_at": pause.expires_at if pause_active else None}, "last_sync": now.isoformat()}

@router.put("/emergency-pause")
def emergency_pause(payload: EmergencyPauseUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    now = datetime.utcnow(); expiry = payload.expires_at.replace(tzinfo=None) if payload.expires_at else None
    if payload.active and expiry and expiry <= now: raise HTTPException(422, "Pause expiry must be in the future.")
    item = db.get(HubEmergencyPause, user.id) or HubEmergencyPause(user_id=user.id)
    item.active = payload.active; item.reason = payload.reason; item.expires_at = expiry if payload.active else None; item.enabled_at = now if payload.active else item.enabled_at
    db.add(item); db.flush()
    audit_request = TrustActionRequest(user_id=user.id, domain="trust", action_type="emergency_pause.enable" if payload.active else "emergency_pause.disable", normalized_payload={"reason": payload.reason, "expires_at": expiry.isoformat() if expiry else None}, risk_level="LOW", status="EXECUTED", idempotency_key=f"pause-{user.id}-{now.timestamp()}")
    db.add(audit_request); db.flush(); db.add(TrustAuditEvent(user_id=user.id, action_request_id=audit_request.id, event_type="EMERGENCY_PAUSE_ENABLED" if payload.active else "EMERGENCY_PAUSE_DISABLED", details={"reason": payload.reason}, previous_hash="", event_hash=hashlib.sha256(f"{audit_request.id}:{payload.active}:{payload.reason}".encode()).hexdigest())); db.commit()
    return {"active": item.active, "reason": item.reason, "expires_at": item.expires_at}

@router.get("/policies")
def policies(search: str = Query(default="", max_length=120), domain: str | None = Query(default=None, max_length=48), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = select(HubPolicyRule).where(HubPolicyRule.user_id == user.id)
    if search: query = query.where(HubPolicyRule.name.ilike(f"%{search}%"))
    if domain: query = query.where(HubPolicyRule.domain == domain)
    return [policy_json(x) for x in db.scalars(query.order_by(HubPolicyRule.priority.desc(), HubPolicyRule.created_at.desc()))]
@router.post("/policies")
def create_policy(payload: PolicyCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rule = HubPolicyRule(user_id=user.id, **payload.model_dump()); db.add(rule); db.commit(); db.refresh(rule); return policy_json(rule)
@router.put("/policies/{policy_id}")
def update_policy(policy_id: str, payload: PolicyUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rule = db.scalar(select(HubPolicyRule).where(HubPolicyRule.id == policy_id, HubPolicyRule.user_id == user.id))
    if not rule: raise HTTPException(404, "Policy not found.")
    if rule.version != payload.version: raise HTTPException(409, "Policy changed elsewhere. Reload and try again.")
    for key, value in payload.model_dump(exclude={"version"}).items(): setattr(rule, key, value)
    rule.version += 1; db.commit(); db.refresh(rule); return policy_json(rule)
@router.post("/policies/{policy_id}/duplicate")
def duplicate_policy(policy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    source = db.scalar(select(HubPolicyRule).where(HubPolicyRule.id == policy_id, HubPolicyRule.user_id == user.id))
    if not source: raise HTTPException(404, "Policy not found.")
    copy = HubPolicyRule(user_id=user.id, name=f"{source.name} copy"[:120], description=source.description, domain=source.domain, priority=source.priority, conditions=source.conditions, effect=source.effect, enabled=False); db.add(copy); db.commit(); db.refresh(copy); return policy_json(copy)
@router.delete("/policies/{policy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_policy(policy_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rule = db.scalar(select(HubPolicyRule).where(HubPolicyRule.id == policy_id, HubPolicyRule.user_id == user.id))
    if not rule: raise HTTPException(404, "Policy not found.")
    db.delete(rule); db.commit()
@router.post("/policies/evaluate")
def evaluate(payload: PolicyEvaluate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rules = list(db.scalars(select(HubPolicyRule).where(HubPolicyRule.user_id == user.id, HubPolicyRule.domain == payload.domain))); result = evaluate_policy(rules, {**payload.context, "action_type": payload.action_type})
    db.add(HubPolicyEvaluation(user_id=user.id, domain=payload.domain, action_type=payload.action_type, context=payload.context, decision=result["decision"], matched_policy_ids=result["matched_policy_ids"], explanation=result["explanation"])); db.commit(); return result
@router.get("/policies/audit")
def policy_audit(limit: int = Query(default=50, ge=1, le=200), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.scalars(select(HubPolicyEvaluation).where(HubPolicyEvaluation.user_id == user.id).order_by(HubPolicyEvaluation.created_at.desc()).limit(limit))
    return [{"id": x.id, "domain": x.domain, "action_type": x.action_type, "context": x.context, "decision": x.decision, "matched_policy_ids": x.matched_policy_ids, "explanation": x.explanation, "created_at": x.created_at} for x in rows]

@router.get("/consent-leases")
def leases(db: Session = Depends(get_db), user: User = Depends(get_current_user)): return [{"id": x.id, "capability": x.capability, "purpose": x.purpose, "fields": x.fields, "status": "ACTIVE" if lease_active(x) else "OS_PERMISSION_MISSING" if not x.os_permission_granted else x.status, "expires_at": x.expires_at} for x in db.scalars(select(HubConsentLease).where(HubConsentLease.user_id == user.id))]
@router.post("/consent-leases")
def create_lease(payload: LeaseCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    expiry = payload.expires_at.replace(tzinfo=None);
    if expiry <= datetime.utcnow(): raise HTTPException(422, "Lease expiry must be in the future.")
    values = payload.model_dump(); values["expires_at"] = expiry; lease = HubConsentLease(user_id=user.id, status="ACTIVE" if payload.os_permission_granted else "OS_PERMISSION_MISSING", **values); db.add(lease); db.commit(); db.refresh(lease); return {"id": lease.id, "status": lease.status}
@router.post("/consent-leases/{lease_id}/revoke")
def revoke(lease_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lease = db.scalar(select(HubConsentLease).where(HubConsentLease.id == lease_id, HubConsentLease.user_id == user.id))
    if not lease: raise HTTPException(404, "Lease not found.")
    lease.status = "REVOKED"; lease.revoked_at = datetime.utcnow(); db.commit(); return {"id": lease.id, "status": lease.status}
@router.post("/consent-leases/{lease_id}/renew")
def renew(lease_id: str, payload: LeaseRenew, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    lease = db.scalar(select(HubConsentLease).where(HubConsentLease.id == lease_id, HubConsentLease.user_id == user.id))
    if not lease: raise HTTPException(404, "Lease not found.")
    expiry = payload.expires_at.replace(tzinfo=None)
    if expiry <= datetime.utcnow(): raise HTTPException(422, "Lease expiry must be in the future.")
    lease.expires_at = expiry; lease.revoked_at = None; lease.status = "ACTIVE" if lease.os_permission_granted else "OS_PERMISSION_MISSING"; db.commit(); return {"id": lease.id, "status": lease.status, "expires_at": lease.expires_at}

@router.get("/authority-settings")
def authorities(db: Session = Depends(get_db), user: User = Depends(get_current_user)): return [{"domain": x.domain, "level": x.level, "temporary_until": x.temporary_until} for x in db.scalars(select(HubAuthoritySetting).where(HubAuthoritySetting.user_id == user.id))]
@router.put("/authority-settings/{domain}")
def authority(domain: str, payload: AuthorityUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    high_risk_domains = {"messages", "calls", "security"}
    if domain in high_risk_domains and payload.level == "EXECUTE_AND_REPORT": raise HTTPException(422, "High-risk domains cannot execute without confirmation.")
    item = db.scalar(select(HubAuthoritySetting).where(HubAuthoritySetting.user_id == user.id, HubAuthoritySetting.domain == domain)) or HubAuthoritySetting(user_id=user.id, domain=domain); item.level = payload.level; db.add(item); db.commit(); return {"domain": domain, "level": item.level}

@router.post("/commitments")
def commitment(payload: CommitmentCreate, idempotency_key: str = Header(min_length=8, max_length=80), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    due = payload.due_at.replace(tzinfo=None)
    if due <= datetime.utcnow(): raise HTTPException(422, "Commitment deadline must be in the future.")
    existing = db.scalar(select(HubActionReceipt).where(HubActionReceipt.user_id == user.id, HubActionReceipt.request_id == idempotency_key))
    if existing: return {"status": "DRAFT", "receipt_id": existing.id, "duplicate": True}
    start = due - timedelta(minutes=payload.estimated_minutes)
    active = list(db.scalars(select(HubCommitment).where(HubCommitment.user_id == user.id, HubCommitment.status.in_(["ACCEPTED", "IN_PROGRESS"]))))
    conflicts = [x.id for x in active if start < x.due_at and due > x.due_at - timedelta(minutes=x.estimated_minutes)]
    item = HubCommitment(user_id=user.id, deliverable=payload.deliverable, owner=payload.owner, due_at=due, estimated_minutes=payload.estimated_minutes, status="DRAFT", feasibility="CONFLICT" if conflicts else "FEASIBLE", conflict_ids=conflicts); receipt = HubActionReceipt(user_id=user.id, action_type="commitment.create", status="COMPLETED_UNVERIFIED", explanation="Draft saved; explicit acceptance is still required.", request_id=idempotency_key); db.add_all([item, receipt]); db.commit(); db.refresh(item); return {**commitment_json(item), "receipt_id": receipt.id}

def commitment_json(item: HubCommitment):
    return {"id": item.id, "deliverable": item.deliverable, "owner": item.owner, "due_at": item.due_at, "estimated_minutes": item.estimated_minutes, "status": item.status, "feasibility": item.feasibility, "conflict_ids": item.conflict_ids or [], "evidence": item.evidence or {}, "recovery_note": item.recovery_note, "version": item.version, "created_at": item.created_at, "updated_at": item.updated_at}

@router.get("/commitments")
def commitments(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [commitment_json(x) for x in db.scalars(select(HubCommitment).where(HubCommitment.user_id == user.id).order_by(HubCommitment.due_at))]

@router.post("/commitments/{commitment_id}/transition")
def transition_commitment(commitment_id: str, payload: CommitmentTransition, idempotency_key: str = Header(min_length=8, max_length=80), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.scalar(select(HubCommitment).where(HubCommitment.id == commitment_id, HubCommitment.user_id == user.id))
    if not item: raise HTTPException(404, "Commitment not found.")
    if item.version != payload.version: raise HTTPException(409, "Commitment changed elsewhere. Reload and try again.")
    allowed = {"DRAFT": {"accept", "reject", "cancel", "renegotiate"}, "ACCEPTED": {"start", "cancel", "renegotiate"}, "IN_PROGRESS": {"submit_evidence", "cancel", "renegotiate"}, "COMPLETED_UNVERIFIED": {"verify", "renegotiate"}}
    if payload.action not in allowed.get(item.status, set()): raise HTTPException(409, f"{payload.action} is not valid while commitment is {item.status}.")
    if payload.action == "accept" and item.conflict_ids and not payload.acknowledge_conflicts: raise HTTPException(409, {"message": "Commitment conflicts require explicit acknowledgement.", "conflict_ids": item.conflict_ids})
    target = {"accept": "ACCEPTED", "reject": "CANCELLED", "start": "IN_PROGRESS", "submit_evidence": "COMPLETED_UNVERIFIED", "verify": "COMPLETED_VERIFIED", "cancel": "CANCELLED", "renegotiate": "DRAFT"}[payload.action]
    def apply_transition(_: dict):
        item.status = target; item.version += 1
        if payload.evidence: item.evidence = payload.evidence
        if payload.action == "renegotiate":
            if not payload.due_at or payload.due_at.replace(tzinfo=None) <= datetime.utcnow(): raise HTTPException(422, "A future deadline is required.")
            item.due_at = payload.due_at.replace(tzinfo=None); item.conflict_ids = []; item.feasibility = "FEASIBLE"
        node = db.scalar(select(HubGraphNode).where(HubGraphNode.user_id == user.id, HubGraphNode.source_type == "commitment", HubGraphNode.source_id == item.id))
        if not node:
            node = HubGraphNode(user_id=user.id, node_type="commitment", label=item.deliverable, details={"status": item.status, "due_at": item.due_at.isoformat()}, source_type="commitment", source_id=item.id); db.add(node); db.flush()
        else: node.details = {**node.details, "status": item.status, "due_at": item.due_at.isoformat()}
        return {"id": item.id, "status": item.status, "version": item.version}
    gateway = authorize_and_execute(db, user.id, GatewayInput("commitments", f"commitment.{payload.action}", {"commitment_id": item.id, "target_status": target}, idempotency_key, resource_id=item.id), apply_transition, preconfirmed=True)
    if gateway.status == GatewayStatus.DENIED: raise HTTPException(403, gateway.explanation)
    if gateway.status == GatewayStatus.CONFIRMATION_REQUIRED: raise HTTPException(409, "Explicit confirmation is required.")
    db.refresh(item); return {**commitment_json(item), "receipt_id": gateway.receipt_id}

def node_json(x: HubGraphNode): return {"id": x.id, "node_type": x.node_type, "label": x.label, "details": x.details, "source_type": x.source_type, "source_id": x.source_id, "archived": x.archived, "created_at": x.created_at}
def edge_json(x: HubGraphEdge): return {"id": x.id, "from_node_id": x.from_node_id, "to_node_id": x.to_node_id, "edge_type": x.edge_type, "confidence": x.confidence, "source": x.source}

@router.get("/life-map")
def life_map(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    nodes = list(db.scalars(select(HubGraphNode).where(HubGraphNode.user_id == user.id, HubGraphNode.archived.is_(False)).order_by(HubGraphNode.created_at.desc()).limit(200)))
    node_ids = [x.id for x in nodes]; edges = list(db.scalars(select(HubGraphEdge).where(HubGraphEdge.user_id == user.id, HubGraphEdge.from_node_id.in_(node_ids), HubGraphEdge.to_node_id.in_(node_ids)))) if node_ids else []
    return {"nodes": [node_json(x) for x in nodes], "edges": [edge_json(x) for x in edges]}

@router.post("/life-map/nodes")
def create_graph_node(payload: GraphNodeCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = HubGraphNode(user_id=user.id, node_type=payload.node_type, label=payload.label, details=payload.details, source_type="user", source_id=f"user-{datetime.utcnow().timestamp()}"); db.add(item); db.commit(); db.refresh(item); return node_json(item)

@router.delete("/life-map/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_graph_node(node_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.scalar(select(HubGraphNode).where(HubGraphNode.id == node_id, HubGraphNode.user_id == user.id))
    if not item: raise HTTPException(404, "Graph node not found.")
    item.archived = True; db.commit()

def _reachable(db: Session, user_id: str, start: str, target: str, limit: int = 200) -> bool:
    queue = [start]; visited: set[str] = set()
    while queue and len(visited) < limit:
        current = queue.pop(0)
        if current == target: return True
        if current in visited: continue
        visited.add(current); queue.extend(db.scalars(select(HubGraphEdge.to_node_id).where(HubGraphEdge.user_id == user_id, HubGraphEdge.from_node_id == current)).all())
    return False

@router.post("/life-map/edges")
def create_graph_edge(payload: GraphEdgeCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    owned = list(db.scalars(select(HubGraphNode.id).where(HubGraphNode.user_id == user.id, HubGraphNode.id.in_([payload.from_node_id, payload.to_node_id]))))
    if len(set(owned)) != 2: raise HTTPException(404, "Graph node not found.")
    if payload.from_node_id == payload.to_node_id or _reachable(db, user.id, payload.to_node_id, payload.from_node_id): raise HTTPException(409, "This relationship would create a cycle.")
    existing = db.scalar(select(HubGraphEdge).where(HubGraphEdge.user_id == user.id, HubGraphEdge.from_node_id == payload.from_node_id, HubGraphEdge.to_node_id == payload.to_node_id, HubGraphEdge.edge_type == payload.edge_type))
    if existing: return edge_json(existing)
    item = HubGraphEdge(user_id=user.id, **payload.model_dump()); db.add(item); db.commit(); db.refresh(item); return edge_json(item)

@router.delete("/life-map/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_graph_edge(edge_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    item = db.scalar(select(HubGraphEdge).where(HubGraphEdge.id == edge_id, HubGraphEdge.user_id == user.id))
    if not item: raise HTTPException(404, "Graph relationship not found.")
    db.delete(item); db.commit()

@router.get("/life-map/nodes/{node_id}/impact")
def graph_impact(node_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    node = db.scalar(select(HubGraphNode).where(HubGraphNode.id == node_id, HubGraphNode.user_id == user.id))
    if not node: raise HTTPException(404, "Graph node not found.")
    queue=[node.id]; visited={node.id}; impacted=[]
    while queue and len(visited) <= 200:
        current=queue.pop(0)
        for edge in db.scalars(select(HubGraphEdge).where(HubGraphEdge.user_id == user.id, HubGraphEdge.from_node_id == current)):
            if edge.to_node_id not in visited: visited.add(edge.to_node_id); queue.append(edge.to_node_id); impacted.append(edge.to_node_id)
    nodes=list(db.scalars(select(HubGraphNode).where(HubGraphNode.user_id == user.id, HubGraphNode.id.in_(impacted)))) if impacted else []
    return {"source": node_json(node), "impacted": [node_json(x) for x in nodes], "bounded": len(visited) >= 200}
