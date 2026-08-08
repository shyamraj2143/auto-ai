from __future__ import annotations

from typing import Final


NOTIFICATION_DESTINATION_BY_TYPE: Final[dict[str, str]] = {
    "apk_update": "APP_UPDATE",
    "call_accepted": "CALL_HISTORY",
    "call_cancelled": "CALL_HISTORY",
    "call_ended": "CALL_HISTORY",
    "call_failed": "CALL_HISTORY",
    "call_missed": "MISSED_CALL",
    "call_rejected": "CALL_HISTORY",
    "chat_message": "MESSAGE_THREAD",
    "follow_accept": "FOLLOW_ACCEPTED",
    "follow_request": "FOLLOW_REQUEST",
    "incoming_call": "INCOMING_CALL",
    "incoming_call_fallback": "INCOMING_CALL",
    "relationship_followup": "RELATIONSHIP_FOLLOWUP",
    "seva_case_update": "SEVA_CASE",
}

ENTITY_FIELD_BY_TYPE: Final[dict[str, str | None]] = {
    "apk_update": "release_id",
    "call_accepted": "call_id",
    "call_cancelled": "call_id",
    "call_ended": "call_id",
    "call_failed": "call_id",
    "call_missed": "call_id",
    "call_rejected": "call_id",
    "chat_message": "thread_id",
    "follow_accept": "actor_id",
    "follow_request": "target_id",
    "incoming_call": "call_id",
    "incoming_call_fallback": "call_id",
    "relationship_followup": "contact_id",
    "seva_case_update": "case_route_id",
}


def with_notification_destination(data: dict[str, str]) -> dict[str, str]:
    notification_type = data.get("type", "")
    destination = NOTIFICATION_DESTINATION_BY_TYPE.get(notification_type)
    if not destination:
        raise ValueError(f"Unmapped notification type: {notification_type}")
    entity_field = ENTITY_FIELD_BY_TYPE[notification_type]
    entity_id = data.get(entity_field, "") if entity_field else ""
    if entity_field and not entity_id and notification_type != "apk_update":
        raise ValueError(f"Missing {entity_field} for notification type: {notification_type}")
    return {
        **data,
        "destination": destination,
        "entity_id": entity_id,
    }
