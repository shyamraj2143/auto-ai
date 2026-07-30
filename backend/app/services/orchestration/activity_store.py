from __future__ import annotations

import re
import threading
from collections import defaultdict
from collections.abc import Iterable

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.chat_generation import OrchestrationEvent
from app.services.orchestration.schemas import utc_iso


ALLOWED_KEYS = {
    "mode",
    "stage",
    "intent",
    "task_id",
    "provider_display_name",
    "model_display_name",
    "role",
    "activity_label",
    "status",
    "started_at",
    "duration_ms",
    "contributed_to_final_answer",
    "models_attempted",
    "models_completed",
    "models_contributed",
    "verified_sources",
    "sources_found",
    "sources_reviewed",
    "sources_accepted",
    "fallback_used",
}
SAFE_TEXT = re.compile(r"^[\w .:/()+&,'-]{0,160}$", re.UNICODE)


def _sanitize(payload: dict) -> dict:
    safe: dict = {}
    for key, value in payload.items():
        if key not in ALLOWED_KEYS:
            continue
        if isinstance(value, str):
            safe[key] = value if SAFE_TEXT.fullmatch(value) else "Processing"
        elif isinstance(value, (bool, int, float)) or value is None:
            safe[key] = value
    return safe


class ActivityStore:
    def __init__(self) -> None:
        self._write_locks: defaultdict[str, threading.Lock] = defaultdict(threading.Lock)

    def emit(self, generation_id: str, user_id: str, event_type: str, payload: dict) -> None:
        with self._write_locks[generation_id]:
            with SessionLocal() as db:
                sequence = int(
                    db.scalar(
                        select(func.coalesce(func.max(OrchestrationEvent.sequence), 0)).where(
                            OrchestrationEvent.generation_id == generation_id
                        )
                    )
                    or 0
                ) + 1
                event_payload = {
                    "event": event_type,
                    "request_id": generation_id,
                    **_sanitize(payload),
                    "occurred_at": utc_iso(),
                }
                db.add(
                    OrchestrationEvent(
                        generation_id=generation_id,
                        user_id=user_id,
                        sequence=sequence,
                        event_type=event_type,
                        payload=event_payload,
                    )
                )
                if sequence > settings.ORCHESTRATION_MAX_EVENTS_PER_GENERATION:
                    db.execute(
                        delete(OrchestrationEvent).where(
                            OrchestrationEvent.generation_id == generation_id,
                            OrchestrationEvent.sequence
                            <= sequence - settings.ORCHESTRATION_MAX_EVENTS_PER_GENERATION,
                        )
                    )
                db.commit()

    @staticmethod
    def list(
        generation_id: str,
        user_id: str,
        *,
        after: int = 0,
        session: Session | None = None,
    ) -> list[OrchestrationEvent]:
        statement = (
            select(OrchestrationEvent)
            .where(
                OrchestrationEvent.generation_id == generation_id,
                OrchestrationEvent.user_id == user_id,
                OrchestrationEvent.sequence > after,
            )
            .order_by(OrchestrationEvent.sequence)
            .limit(settings.ORCHESTRATION_MAX_EVENTS_PER_GENERATION)
        )
        if session is not None:
            return list(session.scalars(statement))
        with SessionLocal() as db:
            return list(db.scalars(statement))

    @staticmethod
    def serialize(events: Iterable[OrchestrationEvent]) -> list[dict]:
        return [{"sequence": event.sequence, **(event.payload or {})} for event in events]

    def summary(self, events: Iterable[OrchestrationEvent]) -> dict:
        cards: dict[str, dict] = {}
        final: dict = {}
        for event in events:
            payload = dict(event.payload or {})
            task_id = payload.get("task_id")
            if task_id and event.event_type.startswith("model."):
                cards[task_id] = {**cards.get(task_id, {}), **payload}
            if event.event_type == "orchestration.completed":
                final = payload
        return {
            "tasks": list(cards.values()),
            "models_attempted": final.get("models_attempted", len(cards)),
            "models_completed": final.get(
                "models_completed", sum(item.get("status") == "completed" for item in cards.values())
            ),
            "models_contributed": final.get(
                "models_contributed", sum(bool(item.get("contributed_to_final_answer")) for item in cards.values())
            ),
            "duration_ms": final.get("duration_ms"),
            "verified_sources": final.get("verified_sources", 0),
            "fallback_used": final.get("fallback_used", False),
        }


activity_store = ActivityStore()
