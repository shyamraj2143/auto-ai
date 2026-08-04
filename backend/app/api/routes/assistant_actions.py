import json
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import ValidationError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.assistant_action import AssistantActionLog
from app.models.intent_engine import ActionReceipt, WorkflowRun
from app.models.user import User
from app.schemas.assistant_action import AssistantActionItem, AssistantCommand, AssistantHistory, AssistantResponse
from app.services.assistant_action_service import assistant_action_service, registry
from app.services.trust_gateway import GatewayInput, GatewayStatus, authorize_and_execute

router = APIRouter(prefix="/assistant", tags=["action-assistant"])

def create_receipt(db: Session, user_id: str, log: AssistantActionLog, result: dict) -> None:
    run = db.scalar(select(WorkflowRun).where(WorkflowRun.user_id == user_id, WorkflowRun.state.notin_(("COMPLETED", "FAILED_FINAL", "CANCELLED", "EXPIRED"))).order_by(WorkflowRun.updated_at.desc()).limit(1))
    if not run:
        return
    key = f"{log.request_id}:{log.tool_name}"
    if db.scalar(select(ActionReceipt).where(ActionReceipt.user_id == user_id, ActionReceipt.idempotency_key == key)):
        return
    evidence = {key: result[key] for key in ("alarm", "client_action", "application_number", "receipt", "delivery_status") if key in result}
    verified = bool(evidence)
    db.add(ActionReceipt(user_id=user_id, run_id=run.id, idempotency_key=key, tool_name=log.tool_name, interpreted_request=str((run.context or {}).get("intent", log.tool_name)), status="VERIFIED" if verified else "ATTEMPTED_UNVERIFIED", evidence=evidence, audit={"permissions_used": [], "data_shared": [], "confirmation_received": log.expires_at is not None, "retry": not verified, "undo": bool(registry.get(log.tool_name) and registry.get(log.tool_name).undo)}))
    run.state = "COMPLETED" if verified else "COMPLETED_UNVERIFIED"

def action_item(log: AssistantActionLog) -> AssistantActionItem:
    manifest = registry.get(log.tool_name)
    result = json.loads(log.result_json)
    message = result.get("error") or {"waiting_confirmation": "Review and confirm this action.", "completed": "Action completed.", "cancelled": "Action cancelled.", "failed": "Action failed."}.get(log.status, "Action is running.")
    return AssistantActionItem(id=log.id, tool_name=log.tool_name, arguments=json.loads(log.arguments_json), risk_level=manifest.risk if manifest else "high", status=log.status, requires_confirmation=bool(manifest and manifest.confirmation), message=message, result=result, undo_supported=bool(manifest and manifest.undo))

@router.post("/command", response_model=AssistantResponse)
def command(payload: AssistantCommand, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> AssistantResponse:
    duplicate = db.scalar(select(AssistantActionLog).where(AssistantActionLog.user_id == user.id, AssistantActionLog.request_id == payload.request_id).order_by(AssistantActionLog.created_at.desc()))
    if duplicate:
        saved = action_item(duplicate)
        return AssistantResponse(mode="confirmation_required" if saved.status == "waiting_confirmation" else "action_only", intent=duplicate.tool_name, assistant_reply=saved.message, actions=[saved], model="groq")
    plan, model = assistant_action_service.plan(payload.message, payload.timezone, payload.context, payload.platform)
    if plan.needs_clarification or not plan.actions: return AssistantResponse(**plan.model_dump(), model=model)
    items = []
    for requested in plan.actions:
        manifest = registry.get(requested.tool_name)
        if not manifest or payload.platform not in manifest.platforms: raise HTTPException(status_code=422, detail="Requested action is unavailable.")
        try: validated = manifest.schema.model_validate(requested.arguments)
        except ValidationError as exc: raise HTTPException(status_code=422, detail="Action arguments are incomplete or invalid.") from exc
        log = AssistantActionLog(user_id=user.id, request_id=payload.request_id, tool_name=manifest.name, arguments_json=validated.model_dump_json(), status="waiting_confirmation" if manifest.confirmation else "executing", expires_at=datetime.utcnow() + timedelta(minutes=10) if manifest.confirmation else None)
        db.add(log); db.commit(); db.refresh(log)
        if not manifest.confirmation:
            try:
                gateway = authorize_and_execute(db, user.id, GatewayInput(domain=manifest.name.split(".", 1)[0], action_type=manifest.name, payload=validated.model_dump(mode="json"), idempotency_key=payload.request_id), lambda _: assistant_action_service.execute(db, user, manifest.name, validated, payload.request_id))
                if gateway.status == GatewayStatus.DENIED:
                    raise HTTPException(status_code=403, detail=gateway.explanation)
                if gateway.status == GatewayStatus.CONFIRMATION_REQUIRED:
                    raise HTTPException(status_code=409, detail="Trust Hub confirmation is required before this action.")
                log.result_json = json.dumps(gateway.adapter_result or {}, ensure_ascii=False); log.status = "completed"; create_receipt(db, user.id, log, gateway.adapter_result or {})
            except HTTPException as exc: db.rollback(); log.result_json = json.dumps({"error": str(exc.detail)}); log.status = "failed"
            db.commit(); db.refresh(log)
        items.append(action_item(log))
    waiting = any(x.status == "waiting_confirmation" for x in items)
    reply = "Please review and confirm." if waiting else ("Action completed." if all(x.status == "completed" for x in items) else "The action could not be completed. Check the result and retry.")
    return AssistantResponse(mode="confirmation_required" if waiting else plan.mode, intent=plan.intent, normalized_user_text=plan.normalized_user_text, assistant_reply=reply, emotion=plan.emotion, actions=items, model=model)

def owned(action_id: str, db: Session, user: User) -> AssistantActionLog:
    log = db.scalar(select(AssistantActionLog).where(AssistantActionLog.id == action_id, AssistantActionLog.user_id == user.id))
    if not log: raise HTTPException(status_code=404, detail="Action not found.")
    return log

@router.post("/actions/{action_id}/confirm", response_model=AssistantActionItem)
def confirm(action_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> AssistantActionItem:
    log = owned(action_id, db, user)
    if log.status != "waiting_confirmation": return action_item(log)
    if not log.expires_at or log.expires_at < datetime.utcnow(): log.status = "cancelled"; log.result_json = json.dumps({"error": "Confirmation expired."}); db.commit(); return action_item(log)
    manifest = registry.get(log.tool_name)
    if not manifest: raise HTTPException(status_code=409, detail="Action is no longer available.")
    try:
        validated = manifest.schema.model_validate_json(log.arguments_json)
        gateway = authorize_and_execute(
            db,
            user.id,
            GatewayInput(domain=manifest.name.split(".", 1)[0], action_type=manifest.name, payload=validated.model_dump(mode="json"), idempotency_key=log.request_id),
            lambda _: assistant_action_service.execute(db, user, log.tool_name, validated, log.request_id),
            preconfirmed=True,
        )
        if gateway.status == GatewayStatus.DENIED:
            raise HTTPException(status_code=403, detail=gateway.explanation)
        log.result_json = json.dumps(gateway.adapter_result or {}, ensure_ascii=False); log.status = "completed"; create_receipt(db, user.id, log, gateway.adapter_result or {})
    except HTTPException as exc: db.rollback(); log.result_json = json.dumps({"error": str(exc.detail)}); log.status = "failed"
    db.commit(); db.refresh(log); return action_item(log)

@router.post("/actions/{action_id}/cancel", response_model=AssistantActionItem)
def cancel(action_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> AssistantActionItem:
    log = owned(action_id, db, user)
    if log.status == "waiting_confirmation": log.status = "cancelled"; db.commit(); db.refresh(log)
    return action_item(log)

@router.get("/history", response_model=AssistantHistory)
def history(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> AssistantHistory:
    return AssistantHistory(items=[action_item(x) for x in db.scalars(select(AssistantActionLog).where(AssistantActionLog.user_id == user.id).order_by(AssistantActionLog.created_at.desc()).limit(100)).all()])

@router.delete("/history", status_code=status.HTTP_204_NO_CONTENT)
def clear_history(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> Response:
    db.execute(delete(AssistantActionLog).where(AssistantActionLog.user_id == user.id)); db.commit(); return Response(status_code=204)
