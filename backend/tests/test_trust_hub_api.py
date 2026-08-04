from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.routes import trust_hub
from app.db.base import Base
from app.db.session import get_db
from app.models.user import User
from datetime import UTC, datetime, timedelta

def setup_client(user_id: str = "policy-user") -> tuple[TestClient, Session]:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine); db = Session(engine)
    user = User(id=user_id, email=f"{user_id}@example.test", name="Policy User", username=user_id, hashed_password="unused", is_active=True); db.add(user); db.commit()
    app = FastAPI(); app.include_router(trust_hub.router, prefix="/api/v1")
    def override_db(): yield db
    app.dependency_overrides[get_db] = override_db; app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app), db

def policy_payload(name: str = "Block selected contact") -> dict:
    return {"name": name, "description": "Prevents accidental contact", "domain": "messages", "priority": 500, "conditions": {"action_type": "message.send", "contact_id": "contact-1"}, "effect": "DENY", "enabled": True}

def test_policy_crud_simulation_audit_and_version_conflict():
    client, db = setup_client()
    try:
        created = client.post("/api/v1/hub/policies", json=policy_payload()).json(); assert created["version"] == 1
        decision = client.post("/api/v1/hub/policies/evaluate", json={"domain": "messages", "action_type": "message.send", "context": {"contact_id": "contact-1"}}).json()
        assert decision["decision"] == "DENY" and decision["matched_policy_ids"] == [created["id"]]
        assert client.get("/api/v1/hub/policies/audit").json()[0]["decision"] == "DENY"
        updated = client.put(f"/api/v1/hub/policies/{created['id']}", json={**policy_payload("Updated policy"), "version": 1}).json(); assert updated["version"] == 2
        assert client.put(f"/api/v1/hub/policies/{created['id']}", json={**policy_payload(), "version": 1}).status_code == 409
        duplicate = client.post(f"/api/v1/hub/policies/{created['id']}/duplicate").json(); assert duplicate["enabled"] is False
        assert client.delete(f"/api/v1/hub/policies/{duplicate['id']}").status_code == 204
    finally: db.close()

def test_policy_routes_are_user_scoped():
    first, first_db = setup_client("first-policy-user"); second, second_db = setup_client("second-policy-user")
    try:
        policy = first.post("/api/v1/hub/policies", json=policy_payload()).json()
        assert second.put(f"/api/v1/hub/policies/{policy['id']}", json={**policy_payload(), "version": 1}).status_code == 404
        assert second.delete(f"/api/v1/hub/policies/{policy['id']}").status_code == 404
    finally: first_db.close(); second_db.close()

def test_commitment_conflict_requires_explicit_acknowledgement_and_receipt():
    client, db = setup_client("commitment-user")
    try:
        due = datetime.now(UTC) + timedelta(hours=4)
        first = client.post("/api/v1/hub/commitments", headers={"idempotency-key": "commitment-first"}, json={"deliverable": "Submit report", "owner": "Me", "due_at": due.isoformat(), "estimated_minutes": 120}).json()
        accepted = client.post(f"/api/v1/hub/commitments/{first['id']}/transition", headers={"idempotency-key": "accept-first-commitment"}, json={"action": "accept", "version": first["version"]})
        assert accepted.status_code == 200 and accepted.json()["status"] == "ACCEPTED"
        second = client.post("/api/v1/hub/commitments", headers={"idempotency-key": "commitment-second"}, json={"deliverable": "Attend interview", "owner": "Me", "due_at": (due - timedelta(minutes=30)).isoformat(), "estimated_minutes": 60}).json()
        assert second["feasibility"] == "CONFLICT" and second["conflict_ids"] == [first["id"]]
        blocked = client.post(f"/api/v1/hub/commitments/{second['id']}/transition", headers={"idempotency-key": "accept-second-blocked"}, json={"action": "accept", "version": second["version"]})
        assert blocked.status_code == 409
        resolved = client.post(f"/api/v1/hub/commitments/{second['id']}/transition", headers={"idempotency-key": "accept-second-confirmed"}, json={"action": "accept", "version": second["version"], "acknowledge_conflicts": True})
        assert resolved.status_code == 200 and resolved.json()["receipt_id"]
    finally: db.close()

def test_life_map_persists_nodes_traverses_impact_and_rejects_cycles():
    client, db = setup_client("graph-user")
    try:
        first = client.post("/api/v1/hub/life-map/nodes", json={"node_type": "task", "label": "Prepare report", "details": {}}).json()
        second = client.post("/api/v1/hub/life-map/nodes", json={"node_type": "deadline", "label": "Submit report", "details": {}}).json()
        edge = client.post("/api/v1/hub/life-map/edges", json={"from_node_id": first["id"], "to_node_id": second["id"], "edge_type": "affects"})
        assert edge.status_code == 200
        impact = client.get(f"/api/v1/hub/life-map/nodes/{first['id']}/impact").json()
        assert [x["id"] for x in impact["impacted"]] == [second["id"]]
        cycle = client.post("/api/v1/hub/life-map/edges", json={"from_node_id": second["id"], "to_node_id": first["id"], "edge_type": "depends_on"})
        assert cycle.status_code == 409
    finally: db.close()
