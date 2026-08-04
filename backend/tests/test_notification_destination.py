import ast
from pathlib import Path

import pytest

from app.services.notification_destination import NOTIFICATION_DESTINATION_BY_TYPE, with_notification_destination


EXPECTED_PUSH_TYPES = {
    "apk_update", "call_accepted", "call_cancelled", "call_ended", "call_failed", "call_missed", "call_rejected",
    "chat_message", "follow_accept", "follow_request", "incoming_call", "incoming_call_fallback", "relationship_followup",
}


def test_every_production_push_type_has_an_explicit_destination() -> None:
    root = Path(__file__).parents[1] / "app" / "services"
    discovered: set[str] = set()
    for path in root.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in EXPECTED_PUSH_TYPES:
                discovered.add(node.value)
    assert discovered == EXPECTED_PUSH_TYPES
    assert set(NOTIFICATION_DESTINATION_BY_TYPE) == EXPECTED_PUSH_TYPES


@pytest.mark.parametrize("notification_type,entity_field", [
    ("chat_message", "thread_id"), ("incoming_call", "call_id"), ("call_accepted", "call_id"),
    ("call_missed", "call_id"),
    ("follow_request", "target_id"), ("follow_accept", "actor_id"),
    ("relationship_followup", "contact_id"),
])
def test_destination_payload_requires_entity(notification_type: str, entity_field: str) -> None:
    with pytest.raises(ValueError, match=entity_field):
        with_notification_destination({"type": notification_type})
