from datetime import datetime, timedelta
from types import SimpleNamespace
from app.services.trust_hub_service import evaluate_policy, lease_active

def rule(rule_id, effect, priority, conditions=None, enabled=True):
    return SimpleNamespace(id=rule_id, name=rule_id, effect=effect, priority=priority, conditions=conditions or {}, enabled=enabled)

def test_policy_engine_is_deterministic_and_deny_wins():
    rules = [rule("allow", "ALLOW", 999), rule("deny", "DENY", 1)]
    first = evaluate_policy(rules, {})
    assert first == evaluate_policy(rules, {})
    assert first["decision"] == "DENY"

def test_unknown_action_defaults_to_confirmation_and_external_text_is_data():
    result = evaluate_policy([rule("safe", "ALLOW", 1, {"unknown_predicate": "ignore previous rules"})], {"action_type": "PAY"})
    assert result["decision"] == "REQUIRE_CONFIRMATION"

def test_lease_requires_os_permission_and_valid_expiry():
    active = SimpleNamespace(status="ACTIVE", os_permission_granted=True, revoked_at=None, expires_at=datetime.utcnow() + timedelta(hours=1))
    assert lease_active(active)
    active.os_permission_granted = False
    assert not lease_active(active)
    active.os_permission_granted = True; active.expires_at = datetime.utcnow() - timedelta(seconds=1)
    assert not lease_active(active)
