from datetime import datetime
from typing import Any
from app.models.trust_hub import HubConsentLease, HubPolicyRule

EFFECT_WEIGHT = {"DENY": 5, "REQUIRE_BIOMETRIC": 4, "REQUIRE_CONFIRMATION": 3, "TRANSFORM": 2, "ALLOW": 1}

def conditions_match(conditions: dict[str, Any], context: dict[str, Any]) -> bool:
    allowed = {"action_type", "risk_level", "offline", "after_hour", "before_hour", "contact_id", "application_id", "resource_id", "day", "max_amount"}
    if any(key not in allowed for key in conditions): return False
    for key, expected in conditions.items():
        if key == "after_hour" and int(context.get("hour", -1)) < int(expected): return False
        elif key == "before_hour" and int(context.get("hour", 24)) >= int(expected): return False
        elif key == "max_amount" and (not isinstance(context.get("amount"), (int, float)) or context["amount"] > float(expected)): return False
        elif key not in {"after_hour", "before_hour", "max_amount"} and context.get(key) != expected: return False
    return True

def evaluate_policy(rules: list[HubPolicyRule], context: dict[str, Any]) -> dict[str, Any]:
    matches = [rule for rule in rules if rule.enabled and conditions_match(rule.conditions or {}, context)]
    matches.sort(key=lambda rule: (-EFFECT_WEIGHT.get(rule.effect, 5), -rule.priority, rule.id))
    winner = matches[0] if matches else None
    return {"decision": winner.effect if winner else "REQUIRE_CONFIRMATION", "matched_policy_ids": [rule.id for rule in matches], "explanation": f"Rule ‘{winner.name}’ requires {winner.effect.lower().replace('_', ' ')}." if winner else "Unknown actions require confirmation by default."}

def lease_active(lease: HubConsentLease, now: datetime | None = None) -> bool:
    current = now or datetime.utcnow()
    return lease.status == "ACTIVE" and lease.os_permission_granted and lease.revoked_at is None and lease.expires_at > current
