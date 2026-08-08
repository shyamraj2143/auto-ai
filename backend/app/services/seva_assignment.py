from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.autoai_seva import SevaAgentProfile, SevaNotification, SevaWorkOrder
from app.models.form_service import HumanHandoff
from app.models.user import User


ACTIVE_STATES = ("IN_PROGRESS", "WAITING_USER", "SUBMITTED")


def notify(db: Session, work_order: SevaWorkOrder, recipient_id: str, event_type: str, title: str, message: str) -> None:
    db.add(SevaNotification(
        work_order_id=work_order.id,
        recipient_user_id=recipient_id,
        event_type=event_type,
        title=title[:180],
        message=message[:1000],
    ))


def assign_best_available_agent(db: Session, work_order: SevaWorkOrder) -> SevaAgentProfile | None:
    if work_order.assigned_employee_id or work_order.status in {"COMPLETED", "CANCELLED"}:
        return None
    profiles = list(db.scalars(
        select(SevaAgentProfile)
        .join(User, User.id == SevaAgentProfile.user_id)
        .where(SevaAgentProfile.is_active.is_(True), User.is_active.is_(True))
        .with_for_update()
    ))
    candidates: list[tuple[int, SevaAgentProfile]] = []
    for profile in profiles:
        active_load = int(db.scalar(select(func.count()).select_from(SevaWorkOrder).where(
            SevaWorkOrder.assigned_employee_id == profile.user_id,
            SevaWorkOrder.status.in_(ACTIVE_STATES),
        )) or 0)
        if active_load < profile.capacity:
            candidates.append((active_load, profile))
    if not candidates:
        work_order.status = "QUEUED"
        return None
    _, agent = min(candidates, key=lambda item: (
        item[0], item[1].last_assigned_at is not None, item[1].last_assigned_at or datetime.min, item[1].created_at
    ))
    now = datetime.utcnow()
    work_order.assigned_employee_id = agent.user_id
    work_order.status = "IN_PROGRESS"
    work_order.claimed_at = now
    agent.last_assigned_at = now
    handoff = db.get(HumanHandoff, work_order.handoff_id)
    if handoff:
        handoff.status = "ACTIVE"
        handoff.agent_identity = {
            "id": agent.user_id,
            "agent_code": agent.agent_code,
            "name": agent.display_name,
            "role": "AutoAI Seva agent",
            "status": "ASSIGNED",
            "verified": True,
        }
    notify(db, work_order, work_order.user_id, "AGENT_ASSIGNED", "Seva agent assigned", f"{agent.display_name} is now working on your application.")
    notify(db, work_order, agent.user_id, "TASK_ASSIGNED", "New Seva task assigned", work_order.request_summary or "A new application needs your attention.")
    return agent


def assign_waiting_work(db: Session) -> None:
    waiting = list(db.scalars(
        select(SevaWorkOrder)
        .where(SevaWorkOrder.status == "QUEUED", SevaWorkOrder.assigned_employee_id.is_(None))
        .order_by(SevaWorkOrder.created_at)
    ))
    for item in waiting:
        if not assign_best_available_agent(db, item):
            break


def queue_position(db: Session, work_order: SevaWorkOrder) -> int | None:
    if work_order.status != "QUEUED" or work_order.assigned_employee_id:
        return None
    return int(db.scalar(
        select(func.count()).select_from(SevaWorkOrder).where(
            SevaWorkOrder.status == "QUEUED",
            SevaWorkOrder.assigned_employee_id.is_(None),
            SevaWorkOrder.created_at <= work_order.created_at,
        )
    ) or 0)
