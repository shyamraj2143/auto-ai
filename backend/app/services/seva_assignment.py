from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.autoai_seva import SevaAgentProfile, SevaAssignment, SevaCaseEvent, SevaNotification, SevaWorkOrder
from app.models.form_service import HumanHandoff, ServiceDefinition, ServiceTask
from app.models.user import User


ACTIVE_STATES = ("IN_PROGRESS", "WAITING_USER", "SUBMITTED")


def case_event(db: Session, work_order: SevaWorkOrder, event_type: str, title: str, *, actor_id: str | None = None, visibility: str = "USER", details: dict | None = None, dedupe_key: str | None = None) -> None:
    key = dedupe_key or f"{event_type}:{datetime.utcnow().timestamp()}"
    if db.scalar(select(SevaCaseEvent.id).where(SevaCaseEvent.work_order_id == work_order.id, SevaCaseEvent.dedupe_key == key)):
        return
    db.add(SevaCaseEvent(work_order_id=work_order.id, actor_user_id=actor_id, visibility=visibility, event_type=event_type, title=title[:180], details=details or {}, dedupe_key=key[:160]))


def notify(db: Session, work_order: SevaWorkOrder, recipient_id: str, event_type: str, title: str, message: str, *, dedupe_key: str | None = None) -> None:
    key = dedupe_key or f"{event_type}:{work_order.id}:{datetime.utcnow().timestamp()}"
    if db.scalar(select(SevaNotification.id).where(SevaNotification.dedupe_key == key)):
        return
    deep_link = f"/seva/applications/{work_order.task_id}" if recipient_id == work_order.user_id else f"/agent/work?case={work_order.id}"
    item = SevaNotification(
        work_order_id=work_order.id,
        recipient_user_id=recipient_id,
        event_type=event_type,
        title=title[:180],
        message=message[:1000],
        deep_link=deep_link,
        dedupe_key=key[:160],
    )
    db.add(item)
    db.flush()
    from app.services.seva_notifications import send_seva_push
    send_seva_push(db, recipient_id, work_order.id, item.id, item.title, item.message, deep_link)


def assign_best_available_agent(db: Session, work_order: SevaWorkOrder) -> SevaAgentProfile | None:
    if work_order.assigned_employee_id or work_order.status in {"COMPLETED", "CANCELLED"}:
        return None
    profiles = list(db.scalars(
        select(SevaAgentProfile)
        .join(User, User.id == SevaAgentProfile.user_id)
        .where(SevaAgentProfile.is_active.is_(True), SevaAgentProfile.status == "ACTIVE", User.is_active.is_(True))
        .with_for_update()
    ))
    candidates: list[tuple[int, SevaAgentProfile]] = []
    task = db.get(ServiceTask, work_order.task_id)
    service = db.get(ServiceDefinition, task.service_id) if task else None
    category = (service.category or "").strip().casefold() if service else ""
    for profile in profiles:
        skills = {str(value).strip().casefold() for value in (profile.specializations or []) if value}
        if skills and category and category not in skills and "all" not in skills:
            continue
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
    db.add(SevaAssignment(work_order_id=work_order.id, agent_user_id=agent.user_id, reason="Automatic least-loaded eligible assignment"))
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
    work_order.current_activity = "Assigned to a Seva agent"
    work_order.progress_percent = max(work_order.progress_percent, 15)
    case_event(db, work_order, "AGENT_ASSIGNED", "Agent assigned", details={"agent_code": agent.agent_code}, dedupe_key=f"assignment:{work_order.id}:{agent.user_id}:{now.isoformat()}")
    notify(db, work_order, work_order.user_id, "AGENT_ASSIGNED", "Seva agent assigned", f"{agent.display_name} is now working on your application.", dedupe_key=f"user-assigned:{work_order.id}:{agent.user_id}:{now.isoformat()}")
    notify(db, work_order, agent.user_id, "TASK_ASSIGNED", "New Seva task assigned", work_order.request_summary or "A new application needs your attention.", dedupe_key=f"agent-assigned:{work_order.id}:{agent.user_id}:{now.isoformat()}")
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
